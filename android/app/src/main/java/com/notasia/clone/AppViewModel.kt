package com.notasia.clone

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.HttpException
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AppViewModel(app: Application) : AndroidViewModel(app) {
  // Se conserva la clave "notas_ia" para no perder el servidor ya configurado.
  private val prefs = app.getSharedPreferences("notas_ia", Context.MODE_PRIVATE)

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

  var serverUrl by mutableStateOf(
    Net.normalize(prefs.getString("server_url", Net.DEFAULT_BASE_URL) ?: Net.DEFAULT_BASE_URL)
  )
    private set

  private var retrying = false

  private val api get() = Net.api(serverUrl)

  fun updateServerUrl(url: String) {
    val normalized = Net.normalize(url)
    serverUrl = normalized
    prefs.edit().putString("server_url", normalized).apply()
    error = null
    selected = null
    refresh()
  }

  fun search() = refresh()

  fun refresh() {
    viewModelScope.launch {
      try {
        list = withContext(Dispatchers.IO) { api.list(query) }
      } catch (e: Exception) {
        error = friendly(e)
      }
    }
  }

  fun toggle(id: String) {
    if (selected?.id == id) {
      close()
      return
    }
    viewModelScope.launch {
      try {
        selected = withContext(Dispatchers.IO) { api.get(id) }
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

  fun transcribe() = mutate { api.transcribe(it) }

  fun summarize() = mutate { api.summarize(it, SummarizeReq()) }

  /**
   * Analiza una nota desde la tarjeta: transcribe (si hace falta) y resume
   * en una sola acción, sin tener que abrir el detalle.
   */
  fun analyze(id: String) {
    if (id.isBlank() || busy) return
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val detail = withContext(Dispatchers.IO) { api.get(id) }
        selected = detail
        answer = ""
        if (detail.status != "ready") {
          selected = withContext(Dispatchers.IO) { api.transcribe(id) }
        }
        selected = withContext(Dispatchers.IO) { api.summarize(id, SummarizeReq()) }
        list = withContext(Dispatchers.IO) { api.list(query) }
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  private fun mutate(block: suspend (String) -> RecordingDto) {
    val id = selected?.id ?: return
    viewModelScope.launch {
      busy = true
      error = null
      try {
        selected = withContext(Dispatchers.IO) { block(id) }
        list = withContext(Dispatchers.IO) { api.list(query) }
      } catch (e: Exception) {
        if (!handleGone(e)) error = friendly(e)
      } finally {
        busy = false
      }
    }
  }

  fun ask(question: String) {
    val id = selected?.id ?: return
    if (question.isBlank()) return
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val res = withContext(Dispatchers.IO) { api.ask(id, AskReq(question.trim())) }
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
    val id = rec.id ?: return
    pendingDelete = null
    viewModelScope.launch {
      try {
        withContext(Dispatchers.IO) { api.delete(id) }
        if (selected?.id == id) close()
        refresh()
      } catch (e: Exception) {
        if (e is HttpException && e.code() == 404) refresh() else error = friendly(e)
      }
    }
  }

  fun upload(file: File, title: String) {
    viewModelScope.launch {
      busy = true
      error = null
      try {
        val audio = file.asRequestBody("audio/mp4".toMediaType())
        val part = MultipartBody.Part.createFormData("audio", file.name, audio)
        val titleBody = title.toRequestBody("text/plain".toMediaType())
        selected = withContext(Dispatchers.IO) { api.upload(part, titleBody) }
        list = withContext(Dispatchers.IO) { api.list(query) }
      } catch (e: Exception) {
        error = friendly(e)
      } finally {
        busy = false
        file.delete()
      }
    }
  }

  /**
   * Reintenta subir grabaciones que quedaron guardadas porque no había red
   * al detener la grabación. Se llama al abrir o volver a la app.
   */
  fun retryPending() {
    if (retrying || RecordingState.isUploading) return
    val pending = getApplication<Application>().filesDir
      .listFiles { f -> f.name.startsWith("nota_") && f.name.endsWith(".m4a") }
      ?.sortedBy { it.lastModified() }
      ?: return
    if (pending.isEmpty()) return

    retrying = true
    viewModelScope.launch {
      busy = true
      for (file in pending) {
        try {
          val started = file.name.removePrefix("nota_").removeSuffix(".m4a")
            .toLongOrNull() ?: file.lastModified()
          val stamp = SimpleDateFormat("dd/MM HH:mm", Locale.getDefault()).format(Date(started))
          val audio = file.asRequestBody("audio/mp4".toMediaType())
          val part = MultipartBody.Part.createFormData("audio", file.name, audio)
          val title = "Nota $stamp".toRequestBody("text/plain".toMediaType())
          withContext(Dispatchers.IO) { api.upload(part, title) }
          file.delete()
        } catch (e: Exception) {
          error = "Quedó una grabación pendiente: ${friendly(e)}"
          break
        }
      }
      try {
        list = withContext(Dispatchers.IO) { api.list(query) }
      } catch (_: Exception) {
      }
      busy = false
      retrying = false
    }
  }

  private fun handleGone(e: Exception): Boolean {
    if (e is HttpException && e.code() == 404) {
      close()
      error = "Esa nota ya no existe. Actualizando la lista…"
      refresh()
      return true
    }
    return false
  }

  private fun friendly(e: Exception): String =
    e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
}
