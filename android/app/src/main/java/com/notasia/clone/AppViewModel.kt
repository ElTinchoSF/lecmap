package com.notasia.clone

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.HttpException
import java.io.File

class AppViewModel(app: Application) : AndroidViewModel(app) {
  // Se conserva la clave "notas_ia" para no perder el servidor ya configurado.
  private val prefs = app.getSharedPreferences("notas_ia", Context.MODE_PRIVATE)
  private val store = LocalStore(app)

  // ---------- Auth state ----------
  var authLoading by mutableStateOf(true)
    private set
  var isLoggedIn by mutableStateOf(false)
    private set
  var userEmail by mutableStateOf(prefs.getString("auth_email", "") ?: "")
    private set
  var authError by mutableStateOf<String?>(null)
    private set

  // S1: true mientras se valida la sesión guardada en el arranque; el gate
  // muestra el splash (nunca la app) hasta que refresh() resuelva.
  var initialSessionCheck by mutableStateOf(false)
    private set

  private var accessToken = prefs.getString("auth_access_token", "") ?: ""
  private var refreshToken = prefs.getString("auth_refresh_token", "") ?: ""

  init {
    // Configurar Supabase desde SharedPreferences (se setea en la primera corrida
    // o desde Ajustes). Si no está configurado, la app funciona sin auth.
    val sbUrl = prefs.getString("supabase_url", "") ?: ""
    val sbKey = prefs.getString("supabase_anon_key", "") ?: ""
    if (sbUrl.isNotEmpty() && sbKey.isNotEmpty()) {
      SupabaseAuth.config = SupabaseConfig(sbUrl, sbKey)
    }
    if (accessToken.isNotEmpty()) {
      // S1: no se asume la sesión abierta: el splash cubre hasta que refresh()
      // confirme si el token sigue vivo (si no, Login antes que la app).
      initialSessionCheck = true
      Net.apiToken = accessToken
      // Intentar refresh en background para mantener la sesión válida.
      viewModelScope.launch { tryRefreshToken() }
    } else {
      Net.apiToken = ""
    }
    authLoading = false
  }

  var list by mutableStateOf<List<RecordingDto>>(emptyList())
    private set
  var selected by mutableStateOf<RecordingDto?>(null)
    private set
  var query by mutableStateOf("")
  var answer by mutableStateOf("")
  var busy by mutableStateOf(false)
    private set
  var error by mutableStateOf<String?>(null)
  var pendingDelete by mutableStateOf<RecordingDto?>(null)
    private set
  var pendingRelease by mutableStateOf<RecordingDto?>(null)
    private set

  /**
   * serverId cuyo detalle se está cargando del servidor (S8): mientras es
   * distinto de null, la tarjeta correspondiente muestra "Cargando nota…".
   */
  var loadingNoteId by mutableStateOf<String?>(null)
    private set

  var serverUrl by mutableStateOf(
    Net.normalize(prefs.getString("server_url", Net.DEFAULT_BASE_URL) ?: Net.DEFAULT_BASE_URL)
  )
    private set

  private val api get() = Net.api(serverUrl)

  /**
   * Guarda la URL del servidor. Devuelve null si quedó guardada, o el motivo
   * del rechazo si la URL no es válida (en ese caso no se persiste nada).
   */
  fun updateServerUrl(url: String): String? {
    val normalized = when (val checked = Net.check(url)) {
      is ServerUrl.Valid -> checked.url
      is ServerUrl.Invalid -> return checked.reason
    }
    serverUrl = normalized
    prefs.edit()
      .putString("server_url", normalized)
      .apply()
    error = null
    selected = null
    refresh()
    return null
  }

  fun search() = refresh()

  // ---------- Auth methods ----------

  fun signIn(email: String, password: String) {
    viewModelScope.launch {
      authLoading = true
      authError = null
      try {
        val res = withContext(Dispatchers.IO) {
          SupabaseAuth.signIn(email.trim(), password)
        }
        persistAuth(res)
      } catch (e: Exception) {
        authError = e.message ?: "Error al iniciar sesión"
      } finally {
        authLoading = false
      }
    }
  }

  fun signUp(email: String, password: String) {
    viewModelScope.launch {
      authLoading = true
      authError = null
      try {
        val res = withContext(Dispatchers.IO) {
          SupabaseAuth.signUp(email.trim(), password)
        }
        persistAuth(res)
      } catch (e: Exception) {
        authError = e.message ?: "Error al crear la cuenta"
      } finally {
        authLoading = false
      }
    }
  }

  /**
   * S3: Continuar con Google — abre el authorize de Supabase en el navegador
   * con flujo PKCE. El callback vuelve por deep link
   * (com.notasia.clone://login-callback) a handleOAuthCallback().
   */
  fun signInWithGoogle() {
    val cfg = SupabaseAuth.config ?: run {
      authError = "Supabase no configurado"
      return
    }
    authError = null
    val verifier = randomCodeVerifier()
    prefs.edit().putString("pkce_verifier", verifier).apply()
    val base = if (cfg.url.endsWith("/")) cfg.url.dropLast(1) else cfg.url
    val redirect = "com.notasia.clone://login-callback"
    val url = "$base/auth/v1/authorize" +
      "?provider=google" +
      "&redirect_to=${Uri.encode(redirect)}" +
      "&code_challenge=${Uri.encode(codeChallengeS256(verifier))}" +
      "&code_challenge_method=s256"
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      getApplication<Application>().startActivity(intent)
    } catch (_: Exception) {
      authError = "No se pudo abrir el navegador"
    }
  }

  /**
   * S3: cierra el OAuth de Google — intercambia el `code` del callback por la
   * sesión (PKCE), o expone el error/cancelación en la pantalla de login.
   */
  fun handleOAuthCallback(code: String?, error: String?) {
    if (code == null) {
      authError = error ?: "Login con Google cancelado"
      return
    }
    val verifier = prefs.getString("pkce_verifier", "") ?: ""
    if (verifier.isEmpty()) {
      authError = "Sesión de Google inválida — probá de nuevo"
      return
    }
    viewModelScope.launch {
      authLoading = true
      try {
        val res = withContext(Dispatchers.IO) {
          SupabaseAuth.pkceExchange(code, verifier)
        }
        prefs.edit().remove("pkce_verifier").apply()
        persistAuth(res)
      } catch (e: Exception) {
        authError = e.message ?: "No se pudo completar el login con Google"
      } finally {
        authLoading = false
      }
    }
  }

  private fun randomCodeVerifier(): String {
    val bytes = ByteArray(64).also { java.security.SecureRandom().nextBytes(it) }
    return android.util.Base64.encodeToString(
      bytes,
      android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
    )
  }

  private fun codeChallengeS256(verifier: String): String {
    val digest = java.security.MessageDigest.getInstance("SHA256")
      .digest(verifier.toByteArray(Charsets.US_ASCII))
    return android.util.Base64.encodeToString(
      digest,
      android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
    )
  }

  fun signOut() {
    viewModelScope.launch {
      val token = accessToken
      withContext(Dispatchers.IO) { SupabaseAuth.signOut(token) }
      accessToken = ""
      refreshToken = ""
      isLoggedIn = false
      userEmail = ""
      Net.apiToken = ""
      prefs.edit()
        .remove("auth_access_token")
        .remove("auth_refresh_token")
        .remove("auth_email")
        .apply()
      list = emptyList()
      selected = null
    }
  }

  /** Configura Supabase (URL + anon key). Se llama desde Ajustes o al iniciar. */
  fun configureSupabase(url: String, anonKey: String) {
    val cleanUrl = url.trim().let { if (it.endsWith("/")) it else "$it/" }
    SupabaseAuth.config = SupabaseConfig(cleanUrl, anonKey.trim())
    prefs.edit()
      .putString("supabase_url", cleanUrl)
      .putString("supabase_anon_key", anonKey.trim())
      .apply()
  }

  private fun persistAuth(res: AuthRes) {
    accessToken = res.accessToken
    refreshToken = res.refreshToken
    isLoggedIn = true
    userEmail = res.user?.email ?: ""
    Net.apiToken = accessToken
    prefs.edit()
      .putString("auth_access_token", accessToken)
      .putString("auth_refresh_token", refreshToken)
      .putString("auth_email", userEmail)
      .apply()
    refresh()
  }

  private suspend fun tryRefreshToken(): Boolean {
    if (refreshToken.isEmpty()) return false
    return try {
      val res = withContext(Dispatchers.IO) {
        SupabaseAuth.refresh(refreshToken)
      }
      accessToken = res.accessToken
      refreshToken = res.refreshToken
      Net.apiToken = accessToken
      prefs.edit()
        .putString("auth_access_token", accessToken)
        .putString("auth_refresh_token", refreshToken)
        .apply()
      true
    } catch (_: Exception) {
      false
    }
  }

  /**
   * Lista las notas locales y las del servidor. La copia local es la fuente
   * para el audio; el servidor aporta transcripción, resumen y mapa.
   */
  fun refresh() {
    viewModelScope.launch {
      // .m4a huérfanos (proceso muerto a mitad de grabación) vuelven como notas.
      withContext(Dispatchers.IO) { store.recoverOrphans() }
      try {
        val server = withContext(Dispatchers.IO) { api.list(query).items }
        withContext(Dispatchers.IO) {
          for (dto in server) dto.id?.let { store.updateFromServer(it, dto) }
        }
        val locals = withContext(Dispatchers.IO) { store.list() }
        list = merge(locals, server)
        error = null
        // S1: una lista del servidor con el token guardado valida la sesión.
        if (accessToken.isNotEmpty()) isLoggedIn = true
      } catch (e: Exception) {
        val locals = withContext(Dispatchers.IO) { store.list() }
        list = merge(locals, emptyList())
        if (e is HttpException && e.code() == 401) {
          // Token expirado: intentar refresh y reintentar una vez.
          val refreshed = tryRefreshToken()
          if (refreshed) {
            try {
              val server = withContext(Dispatchers.IO) { api.list(query).items }
              withContext(Dispatchers.IO) {
                for (dto in server) dto.id?.let { store.updateFromServer(it, dto) }
              }
              val locals2 = withContext(Dispatchers.IO) { store.list() }
              list = merge(locals2, server)
              error = null
              // S1: el refresh del token revalida la sesión.
              if (accessToken.isNotEmpty()) isLoggedIn = true
              return@launch
            } catch (_: Exception) { /* cae al error de abajo */ }
          }
          // Sesión inválida: volver al login. S1: nunca con grabación activa —
          // si al terminar la toma sigue inválida, el refresh post-grabación
          // (savedLocalId) la cierra recién ahí.
          if (!RecordingState.isRecording && !RecordingState.isPaused) {
            isLoggedIn = false
            Net.apiToken = ""
          }
        } else {
          // S1: sin red u otro error no invalida la sesión guardada.
          if (accessToken.isNotEmpty()) isLoggedIn = true
          if (locals.isEmpty()) error = friendly(e)
        }
      } finally {
        // S1: el splash termina con la primera resolución de refresh().
        if (initialSessionCheck) initialSessionCheck = false
      }
    }
  }

  fun toggle(rec: RecordingDto) {
    if (selected?.id == rec.id) {
      close()
      return
    }
    val serverId = rec.serverId
    if (serverId == null) {
      selected = rec
      answer = ""
      return
    }
    loadingNoteId = serverId
    viewModelScope.launch {
      try {
        val detail = withContext(Dispatchers.IO) { api.get(serverId) }
        val local = withContext(Dispatchers.IO) { store.findByServerId(serverId) }
        selected = if (local != null) detail.withLocal(local) else detail
        answer = ""
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        loadingNoteId = null
      }
    }
  }

  fun close() {
    selected = null
    answer = ""
  }

  /** S2: renombra la copia local de una nota recién guardada (sin servidor). */
  fun renameLocal(localId: String, newTitle: String) {
    viewModelScope.launch {
      try {
        withContext(Dispatchers.IO) { store.setTitle(localId, newTitle) }
        refresh()
      } catch (e: Exception) {
        error = friendly(e)
      }
    }
  }

  /** S4: renombra en el servidor (PATCH) y sincroniza la copia local y la lista. */
  fun renameServer(serverId: String, localId: String?, newTitle: String) {
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val detail = withContext(Dispatchers.IO) { api.rename(serverId, RenameReq(newTitle)) }
        val finalTitle = detail.title ?: newTitle
        if (localId != null) {
          withContext(Dispatchers.IO) { store.setTitle(localId, finalTitle) }
        } else {
          withContext(Dispatchers.IO) { store.updateFromServer(serverId, detail) }
        }
        if (selected?.serverId == serverId) selected = selected?.copy(title = finalTitle)
        refresh()
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  fun transcribe() {
    val rec = selected ?: return
    val serverId = rec.serverId
    if (serverId == null) {
      analyze(rec)
      return
    }
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val local = withContext(Dispatchers.IO) { store.findByServerId(serverId) }
        if (rec.audioPath == null && local?.audioFile != null) {
          val file = File(local.audioFile)
          if (file.exists()) {
            val part = MultipartBody.Part.createFormData(
              "audio", file.name, file.asRequestBody("audio/mp4".toMediaType())
            )
            withContext(Dispatchers.IO) { api.uploadAudio(serverId, part) }
          }
        }
        val detail = withContext(Dispatchers.IO) { api.transcribe(serverId) }
        store.updateFromServer(serverId, detail)
        selected = store.findByServerId(serverId)?.let { detail.withLocal(it) } ?: detail
        refresh()
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  fun summarize() {
    val rec = selected ?: return
    val serverId = rec.serverId
    if (serverId == null) {
      analyze(rec)
      return
    }
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val started = withContext(Dispatchers.IO) { api.summarize(serverId, SummarizeReq()) }
        if (started.status == "summarizing") {
          selected = selected?.copy(status = "summarizing")
          list = list.map { if (it.serverId == serverId) it.copy(status = "summarizing", error = null) else it }
        }
        val detail = if (started.status == "summarizing" || started.summary.isNullOrBlank()) {
          awaitSummary(serverId)
        } else {
          started
        }
        store.updateFromServer(serverId, detail)
        selected = store.findByServerId(serverId)?.let { detail.withLocal(it) } ?: detail
        refresh()
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  /**
   * Analiza una nota desde la tarjeta: si es local la sube una sola vez, y
   * después transcribe y resume en el servidor. El audio local no se borra.
   */
  fun analyze(rec: RecordingDto) {
    if (busy) return
    viewModelScope.launch {
      busy = true
      error = null
      var local = rec.localId?.let { store.get(it) }
        ?: rec.serverId?.let { store.findByServerId(it) }
      try {
        var serverId = rec.serverId ?: local?.serverId
        var current = rec

        if (serverId == null) {
          val l = local ?: throw IllegalStateException("No hay una copia local de esta nota")
          val file = l.audioFile?.let { File(it) }?.takeIf { it.exists() }
            ?: throw IllegalStateException("El audio local ya no está disponible")
          val part = MultipartBody.Part.createFormData(
            "audio", file.name, file.asRequestBody("audio/mp4".toMediaType())
          )
          val titleBody = l.title.toRequestBody("text/plain".toMediaType())
          val created = withContext(Dispatchers.IO) { api.upload(part, titleBody) }
          serverId = created.id ?: throw IllegalStateException("El servidor no devolvió un id")
          store.setServerId(l.localId, serverId)
          current = created
        }

        if (current.transcript.isNullOrEmpty()) {
          if (current.audioPath == null) {
            val l = local ?: store.findByServerId(serverId)
            val file = l?.audioFile?.let { File(it) }?.takeIf { it.exists() }
            if (file != null) {
              val part = MultipartBody.Part.createFormData(
                "audio", file.name, file.asRequestBody("audio/mp4".toMediaType())
              )
              withContext(Dispatchers.IO) { api.uploadAudio(serverId, part) }
            } else {
              throw IllegalStateException("No hay audio disponible para transcribir")
            }
          }
          current = withContext(Dispatchers.IO) { api.transcribe(serverId) }
          store.updateFromServer(serverId, current)
          selected = current
        }

        if (current.summary.isNullOrBlank()) {
          val started = withContext(Dispatchers.IO) { api.summarize(serverId, SummarizeReq()) }
          if (started.status == "summarizing") {
            selected = current.copy(status = "summarizing")
            list = list.map { if (it.serverId == serverId) it.copy(status = "summarizing", error = null) else it }
          }
          current = if (started.status == "summarizing" || started.summary.isNullOrBlank()) {
            awaitSummary(serverId)
          } else {
            started
          }
          store.updateFromServer(serverId, current)
        }

        local = store.findByServerId(serverId)
        selected = if (local != null) current.withLocal(local) else current
        refresh()
      } catch (e: Exception) {
        if (!handleGone(e)) {
          error = friendly(e)
          local?.let { store.setStatus(it.localId, "error", friendly(e)) }
          refresh()
        }
      } finally {
        busy = false
      }
    }
  }

  fun ask(question: String) {
    val rec = selected ?: return
    val serverId = rec.serverId
    if (serverId == null) {
      error = "Analizá la nota primero para poder preguntarle a ApIA."
      return
    }
    if (question.isBlank()) return
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val res = withContext(Dispatchers.IO) { api.ask(serverId, AskReq(question.trim())) }
        answer = res.answer.orEmpty().ifBlank { "Sin respuesta." }
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  fun requestDelete(rec: RecordingDto) {
    pendingDelete = rec
  }

  fun cancelDelete() {
    pendingDelete = null
  }

  fun confirmDelete() {
    val rec = pendingDelete ?: return
    pendingDelete = null
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val serverId = rec.serverId
        if (serverId != null) {
          try {
            val res = withContext(Dispatchers.IO) { api.delete(serverId) }
            if (!res.isSuccessful && res.code() != 404) throw HttpException(res)
          } catch (e: HttpException) {
            if (e.code() != 404) throw e
          }
        }
        rec.localId?.let { withContext(Dispatchers.IO) { store.delete(it) } }
          ?: rec.serverId?.let { withContext(Dispatchers.IO) { store.deleteByServerId(it) } }
        if (selected?.id == rec.id) close()
        refresh()
      } catch (e: Exception) {
        error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  fun requestReleaseAudio(rec: RecordingDto) {
    pendingRelease = rec
  }

  fun cancelReleaseAudio() {
    pendingRelease = null
  }

  fun confirmReleaseAudio() {
    val rec = pendingRelease ?: return
    pendingRelease = null
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val localId = rec.localId
        if (localId != null) {
          withContext(Dispatchers.IO) {
            store.get(localId)?.audioFile?.let { path ->
              try {
                File(path).delete()
              } catch (_: Exception) {
              }
            }
            store.setAudioFile(localId, null)
          }
        }
        if (selected?.id == rec.id) selected = selected?.copy(hasLocalAudio = false)
        refresh()
      } catch (e: Exception) {
        error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  fun localAudioPath(rec: RecordingDto): File? {
    val localId = rec.localId ?: return null
    val path = store.get(localId)?.audioFile ?: return null
    return File(path).takeIf { it.exists() }
  }

  fun serverAudioUrl(rec: RecordingDto): String? {
    val name = rec.audioPath
      ?.substringAfterLast('/')
      ?.substringAfterLast('\\')
      ?.takeIf { it.isNotBlank() }
      ?: return null
    return Net.normalize(serverUrl) + "files/" + name
  }

  private suspend fun awaitSummary(serverId: String): RecordingDto = withContext(Dispatchers.IO) {
    val deadline = System.currentTimeMillis() + 12 * 60_000
    while (System.currentTimeMillis() < deadline) {
      delay(2500)
      val d = api.get(serverId)
      if (!d.summary.isNullOrBlank()) return@withContext d
      if (d.status == "error") throw IllegalStateException(d.error ?: "No se pudo resumir")
    }
    throw IllegalStateException("El resumen está tardando demasiado. Probá de nuevo en unos minutos.")
  }

  private fun merge(locals: List<LocalNote>, server: List<RecordingDto>): List<RecordingDto> {
    val byServer = server.filter { it.id != null }.associateBy { it.id!! }
    val used = mutableSetOf<String>()
    val out = mutableListOf<RecordingDto>()

    for (local in locals) {
      val remote = local.serverId?.let { byServer[it] }
      if (remote != null) {
        used.add(remote.id!!)
        out.add(remote.withLocal(local))
      } else {
        out.add(local.toDto(null))
      }
    }
    for (remote in server) {
      if (remote.id != null && !used.contains(remote.id)) out.add(remote)
    }
    return out
  }

  private fun LocalNote.toDto(remote: RecordingDto?): RecordingDto = RecordingDto(
    id = remote?.id ?: localId,
    title = remote?.title?.takeIf { it.isNotBlank() } ?: title,
    status = remote?.status ?: status,
    error = remote?.error ?: error,
    audioPath = remote?.audioPath,
    summary = remote?.summary ?: summary,
    mindmap = remote?.mindmap ?: mindmap,
    transcript = remote?.transcript?.takeIf { it.isNotEmpty() } ?: transcript,
    localId = localId,
    serverId = remote?.id ?: serverId,
    hasLocalAudio = audioFile?.let { File(it).exists() } == true,
  )

  private fun RecordingDto.withLocal(local: LocalNote): RecordingDto = copy(
    localId = local.localId,
    serverId = id,
    hasLocalAudio = local.audioFile?.let { File(it).exists() } == true,
    title = title?.takeIf { it.isNotBlank() } ?: local.title,
    status = status ?: local.status,
    error = if (!summary.isNullOrBlank()) null else (error ?: local.error),
    summary = summary ?: local.summary,
    mindmap = mindmap ?: local.mindmap,
    transcript = transcript?.takeIf { it.isNotEmpty() } ?: local.transcript,
  )

  private fun handleGone(e: Exception): Boolean {
    if (e is HttpException && e.code() == 404) {
      close()
      error = "Esa nota ya no existe en el servidor. La copia local sigue disponible."
      refresh()
      return true
    }
    return false
  }

  private fun friendly(e: Exception): String =
    if (e is HttpException && e.code() == 401)
      "Sesión expirada. Volvé a iniciar sesión."
    else e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
}
