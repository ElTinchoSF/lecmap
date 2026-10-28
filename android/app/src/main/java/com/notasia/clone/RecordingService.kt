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

  /** S3: grabación en pausa (MediaRecorder.pause()). La UI muestra "Reanudar". */
  var isPaused by mutableStateOf(false)
    internal set
  var isUploading by mutableStateOf(false)
    internal set
  var startedAt by mutableStateOf(0L)
    internal set
  var uploadError by mutableStateOf<String?>(null)
  var savedLocalId by mutableStateOf<String?>(null)
    internal set

  /**
   * S2: título sugerido de la nota recién guardada. La UI lo consume al ver
   * [savedLocalId] y abre el diálogo para que el usuario elija el nombre.
   */
  var pendingTitle by mutableStateOf<String?>(null)
    internal set

  /**
   * Ruta absoluta del `.m4a` en curso. Mientras existe, `LocalStore.recoverOrphans()`
   * la excluye: sin esto, cualquier `refresh()` a mitad de grabación trataba el
   * archivo como huérfano y creaba una nota fantasma antes de presionar Detener.
   */
  @Volatile
  @JvmStatic
  var activeFile: String? = null
    internal set

  fun clearUploadError() {
    uploadError = null
  }

  fun consumeSaved(): String? {
    val id = savedLocalId
    savedLocalId = null
    return id
  }

  fun consumePendingTitle(): String? {
    val t = pendingTitle
    pendingTitle = null
    return t
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
    const val ACTION_PAUSE = "com.notasia.clone.action.PAUSE"
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
      ACTION_PAUSE -> togglePause()
    }
    return START_NOT_STICKY
  }

  /** S3: pausa/reanuda la toma en curso y refleja el estado en la notificación. */
  private fun togglePause() {
    val r = recorder ?: return
    try {
      if (RecordingState.isPaused) {
        r.resume()
        RecordingState.isPaused = false
        refreshNotification("Grabando… tocá Detener para finalizar")
      } else {
        r.pause()
        RecordingState.isPaused = true
        refreshNotification("En pausa… tocá Detener para guardar")
      }
    } catch (e: Exception) {
      // Estado inconsistente (p.ej. stop() intermedio): el usuario lo ve en la UI.
      RecordingState.uploadError = if (RecordingState.isPaused) {
        "No se pudo reanudar la grabación"
      } else {
        "No se pudo pausar la grabación"
      }
    }
  }

  private fun refreshNotification(text: String) {
    getSystemService(NotificationManager::class.java)
      .notify(NOTIFICATION_ID, buildNotification(text))
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
    // S3: acción de pausa/reanudar también desde la notificación (el estado
    // isPaused define qué acción y qué texto muestra).
    val pause = PendingIntent.getService(
      this,
      2,
      Intent(this, RecordingService::class.java).setAction(ACTION_PAUSE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Lecmap")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .addAction(0, if (RecordingState.isPaused) "Reanudar" else "Pausar", pause)
      .addAction(0, "Detener", stop)
      .build()
  }

  @Suppress("DEPRECATION")
  private fun newRecorder(): MediaRecorder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else MediaRecorder()

  private fun startRecording() {
    // Un solo timestamp: el nombre del archivo Y startedAt salen de acá. Antes
    // el nombre usaba currentTimeMillis() y startedAt se asignaba después de
    // prepare() (+370 ms), lo que producía dos localId distintos para la misma
    // toma y el duplicado reportado en S1.
    val start = System.currentTimeMillis()
    val file = File(filesDir, "nota_$start.m4a")
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
      startedAt = start
      RecordingState.isRecording = true
      RecordingState.isPaused = false
      RecordingState.startedAt = start
      RecordingState.activeFile = file.absolutePath
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
      RecordingState.activeFile = null
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
      // Detener desde pausa guarda UNA sola nota con todo el audio (S3):
      // MediaRecorder.stop() acepta el estado paused y cierra el archivo.
      RecordingState.isPaused = false
      RecordingState.startedAt = 0L
      // El archivo ya no está en curso: recoverOrphans vuelve a poder verlo
      // (si la upsert async de abajo no llega, la recupera él como huérfano
      // real — con el mismo localId, así que no se duplica).
      RecordingState.activeFile = null
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
        RecordingState.pendingTitle = title
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
    // El servicio murió SIN la acción Detener (lo mató el sistema o la app):
    // el .m4a NO se borra. Se corta la grabación y se guarda la nota local para
    // que la toma sea recuperable; si eso falla, el barrido de huérfanos de
    // LocalStore.recoverOrphans() la recupera al próximo refresh.
    if (recorder != null) {
      try {
        recorder?.stop()
      } catch (_: Exception) {
      }
      recorder?.release()
      recorder = null
      val file = output
      val start = if (startedAt > 0L) startedAt else System.currentTimeMillis()
      output = null
      startedAt = 0L
      RecordingState.isRecording = false
      RecordingState.isPaused = false
      RecordingState.startedAt = 0L
      RecordingState.activeFile = null

      if (file != null && file.exists() && file.length() > 0L) {
        try {
          val title = "Nota " + SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
            .format(Date(start))
          LocalStore(applicationContext).upsert(
            LocalNote(
              localId = "local_$start",
              serverId = null,
              title = title,
              createdAt = start,
              status = "local",
              audioFile = file.absolutePath,
            )
          )
        } catch (_: Exception) {
          // El archivo queda en filesDir y lo recupera recoverOrphans().
        }
      }
    }
    scope.cancel()
    super.onDestroy()
  }
}
