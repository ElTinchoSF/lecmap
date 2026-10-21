package com.notasia.clone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Estado compartido entre el servicio de grabación y la UI.
 * Vive en el proceso, así la pantalla puede apagarse sin perder la grabación.
 */
object RecordingState {
  var isRecording by mutableStateOf(false)
    internal set
  var isUploading by mutableStateOf(false)
    internal set
  var startedAt by mutableStateOf(0L)
    internal set
  var uploadError by mutableStateOf<String?>(null)
  var savedLocalId by mutableStateOf<String?>(null)
    internal set

  fun clearUploadError() {
    uploadError = null
  }

  fun consumeSaved(): String? {
    val id = savedLocalId
    savedLocalId = null
    return id
  }
}

/**
 * Servicio en primer plano con tipo "microphone": sigue grabando con la
 * pantalla apagada, la app en segundo plano o el teléfono bloqueado.
 *
 * Al detener guarda el .m4a en el teléfono y crea una nota local. No sube nada:
 * el audio solo se envía al servidor cuando el usuario toca "Analizar".
 */
class RecordingService : Service() {
  companion object {
    const val ACTION_START = "com.notasia.clone.action.START"
    const val ACTION_STOP = "com.notasia.clone.action.STOP"
    private const val CHANNEL_ID = "grabacion"
    private const val NOTIFICATION_ID = 42
  }

  private var recorder: MediaRecorder? = null
  private var output: File? = null
  private var startedAt: Long = 0L
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> if (recorder == null) startRecording()
      ACTION_STOP -> stopAndSave()
    }
    return START_NOT_STICKY
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Grabación de Lecmap",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Muestra que Lecmap está grabando"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  private fun buildNotification(text: String): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, RecordingService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Lecmap")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .addAction(0, "Detener", stop)
      .build()
  }

  @Suppress("DEPRECATION")
  private fun newRecorder(): MediaRecorder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else MediaRecorder()

  private fun startRecording() {
    val file = File(filesDir, "nota_${System.currentTimeMillis()}.m4a")
    try {
      recorder = newRecorder().apply {
        setAudioSource(MediaRecorder.AudioSource.MIC)
        setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        // 32 kbps mono: ~14 MB por hora, dentro del límite de 25 MB de Groq.
        setAudioEncodingBitRate(32_000)
        setAudioSamplingRate(44_100)
        setAudioChannels(1)
        setOutputFile(file.absolutePath)
        prepare()
        start()
      }
      output = file
      startedAt = System.currentTimeMillis()
      RecordingState.isRecording = true
      RecordingState.startedAt = startedAt
      RecordingState.uploadError = null
      RecordingState.savedLocalId = null

      val notification = buildNotification("Grabando… tocá Detener para finalizar")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      recorder?.release()
      recorder = null
      output = null
      file.delete()
      RecordingState.isRecording = false
      RecordingState.uploadError = "No se pudo iniciar la grabación"
      stopForegroundCompat()
      stopSelf()
    }
  }

  private fun stopAndSave() {
    val file = output
    val start = if (startedAt > 0L) startedAt else System.currentTimeMillis()
    var failed = false
    try {
      recorder?.stop()
    } catch (e: Exception) {
      failed = true
    } finally {
      recorder?.release()
      recorder = null
      output = null
      startedAt = 0L
      RecordingState.isRecording = false
      RecordingState.startedAt = 0L
    }

    if (failed || file == null || !file.exists() || file.length() == 0L) {
      file?.delete()
      RecordingState.uploadError = "La grabación quedó vacía"
      stopForegroundCompat()
      stopSelf()
      return
    }

    RecordingState.isUploading = true
    getSystemService(NotificationManager::class.java)
      .notify(NOTIFICATION_ID, buildNotification("Guardando en el teléfono…"))

    val localId = "local_$start"
    val title = "Nota " + SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
      .format(Date(start))
    val note = LocalNote(
      localId = localId,
      serverId = null,
      title = title,
      createdAt = start,
      status = "local",
      audioFile = file.absolutePath,
    )

    scope.launch {
      try {
        LocalStore(applicationContext).upsert(note)
        RecordingState.savedLocalId = localId
        RecordingState.uploadError = null
      } catch (e: Exception) {
        RecordingState.uploadError = "No se pudo guardar la nota: ${e.message ?: "error"}"
      } finally {
        RecordingState.isUploading = false
        stopForegroundCompat()
        stopSelf()
      }
    }
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  override fun onDestroy() {
    scope.cancel()
    if (recorder != null) {
      try {
        recorder?.stop()
      } catch (_: Exception) {
      }
      recorder?.release()
      recorder = null
      startedAt = 0L
      RecordingState.isRecording = false
      RecordingState.startedAt = 0L
      output?.delete()
      output = null
    }
    super.onDestroy()
  }
}
