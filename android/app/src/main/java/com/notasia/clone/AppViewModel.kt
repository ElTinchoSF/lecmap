package com.notasia.clone

import android.app.Application
import android.content.Context
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

  var serverUrl by mutableStateOf(
    Net.normalize(prefs.getString("server_url", Net.DEFAULT_BASE_URL) ?: Net.DEFAULT_BASE_URL)
  )
    private set

  var apiToken by mutableStateOf(prefs.getString("api_token", "") ?: "")
    private set

  init {
    Net.apiToken = apiToken
  }

  private val api get() = Net.api(serverUrl)

  fun updateServerUrl(url: String, token: String = apiToken) {
    val normalized = Net.normalize(url)
    serverUrl = normalized
    apiToken = token.trim()
    Net.apiToken = apiToken
    prefs.edit()
      .putString("server_url", normalized)
      .putString("api_token", apiToken)
      .apply()
    error = null
    selected = null
    refresh()
  }

  fun search() = refresh()

  /**
   * Lista las notas locales y las del servidor. La copia local es la fuente
   * para el audio; el servidor aporta transcripción, resumen y mapa.
   */
  fun refresh() {
    viewModelScope.launch {
      // .m4a huérfanos (proceso muerto a mitad de grabación) vuelven como notas.
      withContext(Dispatchers.IO) { store.recoverOrphans() }
      try {
        val server = withContext(Dispatchers.IO) { api.list(query) }
        withContext(Dispatchers.IO) {
          for (dto in server) dto.id?.let { store.updateFromServer(it, dto) }
        }
        val locals = withContext(Dispatchers.IO) { store.list() }
        list = merge(locals, server)
      } catch (e: Exception) {
        val locals = withContext(Dispatchers.IO) { store.list() }
        list = merge(locals, emptyList())
        if (locals.isEmpty() || (e is HttpException && e.code() == 401)) error = friendly(e)
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
    viewModelScope.launch {
      try {
        val detail = withContext(Dispatchers.IO) { api.get(serverId) }
        val local = withContext(Dispatchers.IO) { store.findByServerId(serverId) }
        selected = if (local != null) detail.withLocal(local) else detail
        answer = ""
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      }
    }
  }

  fun close() {
    selected = null
    answer = ""
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
      "Token de API inválido o ausente. Configuralo en Cambiar servidor."
    else e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
}
