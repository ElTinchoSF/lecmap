package com.notasia.clone

import android.Manifest
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import java.io.File
import java.util.Locale

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      LecmapTheme { AppScreen() }
    }
  }
}

/** Arranca el servicio en primer plano (obligatorio para grabar en segundo plano). */
private fun startRecordingService(context: Context) {
  val intent = Intent(context, RecordingService::class.java)
    .setAction(RecordingService.ACTION_START)
  ContextCompat.startForegroundService(context, intent)
}

@Composable
fun AppScreen(vm: AppViewModel = viewModel()) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  var question by remember { mutableStateOf("") }
  var showServer by remember { mutableStateOf(false) }
  var showLogout by remember { mutableStateOf(false) }

  // Al volver a la app, reintenta grabaciones que quedaron sin subir.
  DisposableEffect(lifecycleOwner) {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_RESUME) {
        vm.refresh()
      }
    }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  val permissionLauncher = rememberLauncherForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) {
    // Puede haberse pedido solo el permiso de notificaciones: verificamos el
    // micrófono directamente en vez de confiar en el mapa de resultados.
    val granted = ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) {
      startRecordingService(context)
    } else {
      vm.error = "Permiso de micrófono denegado"
    }
  }

  LaunchedEffect(Unit) {
    vm.refresh()
  }

  // Auth gate: si Supabase está configurado y no hay sesión, mostrar login.
  if (SupabaseAuth.config != null && !vm.authLoading && !vm.isLoggedIn) {
    LoginScreen(vm)
    return
  }

  // El servicio guarda la nota local aunque la app esté en segundo plano.
  LaunchedEffect(RecordingState.savedLocalId) {
    if (RecordingState.consumeSaved() != null) vm.refresh()
  }

  LaunchedEffect(RecordingState.uploadError) {
    RecordingState.uploadError?.let {
      vm.error = it
      RecordingState.clearUploadError()
    }
  }

  fun toggleRecording() {
    if (RecordingState.isRecording) {
      context.startService(
        Intent(context, RecordingService::class.java)
          .setAction(RecordingService.ACTION_STOP)
      )
      return
    }

    val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      needed.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    val missing = needed.filter {
      ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isEmpty()) {
      startRecordingService(context)
    } else {
      permissionLauncher.launch(missing.toTypedArray())
    }
  }

  val busy = vm.busy || RecordingState.isUploading

  Scaffold(containerColor = Bg) { padding ->
    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      item {
        Header(
          recording = RecordingState.isRecording,
          serverUrl = vm.serverUrl,
          busy = busy,
          email = vm.userEmail,
          onToggle = ::toggleRecording,
          onServer = { showServer = true },
          onLogout = { showLogout = true },
        )
      }

      if (busy) {
        item { LinearProgressIndicator(Modifier.fillMaxWidth(), color = Accent) }
      }

      item { SearchRow(vm) }

      vm.error?.let { message ->
        item { ErrorBanner(message) { vm.error = null } }
      }

      items(vm.list, key = { it.id ?: it.hashCode().toString() }) { rec ->
        Column {
          RecordingCard(
            rec = rec,
            active = vm.selected?.id == rec.id,
            busy = busy,
            onClick = { vm.toggle(rec) },
            onAnalyze = { vm.analyze(rec) },
          )
          if (vm.selected?.id == rec.id) {
            Detail(
              rec = vm.selected ?: rec,
              vm = vm,
              question = question,
              onQuestion = { question = it },
            )
          }
        }
      }
    }
  }

  vm.pendingDelete?.let { target ->
    AlertDialog(
      onDismissRequest = { vm.cancelDelete() },
      containerColor = Surface1,
      title = { Text("Eliminar grabación", color = TextPrimary) },
      text = { Text("¿Eliminar \"${target.title.orEmpty()}\"?", color = TextSecondary) },
      confirmButton = {
        TextButton(onClick = { vm.confirmDelete() }) { Text("Eliminar", color = Danger) }
      },
      dismissButton = {
        TextButton(onClick = { vm.cancelDelete() }) { Text("Cancelar", color = TextSecondary) }
      },
    )
  }

  vm.pendingRelease?.let { target ->
    AlertDialog(
      onDismissRequest = { vm.cancelReleaseAudio() },
      containerColor = Surface1,
      title = { Text("Liberar audio", color = TextPrimary) },
      text = {
        Text(
          "Se borrará el audio de \"${target.title.orEmpty()}\" guardado en el teléfono. " +
            "La transcripción, el resumen y el mapa se conservan. ¿Continuar?",
          color = TextSecondary,
        )
      },
      confirmButton = {
        TextButton(onClick = { vm.confirmReleaseAudio() }) { Text("Liberar", color = Danger) }
      },
      dismissButton = {
        TextButton(onClick = { vm.cancelReleaseAudio() }) { Text("Cancelar", color = TextSecondary) }
      },
    )
  }

  if (showLogout) {
    AlertDialog(
      onDismissRequest = { showLogout = false },
      containerColor = Surface1,
      title = { Text("Cerrar sesión", color = TextPrimary) },
      text = {
        Text(
          buildString {
            append("Vas a cerrar sesión en ")
            append(vm.userEmail.ifBlank { "esta cuenta" })
            append(".\n\nTus grabaciones se conservan en el servidor y volverán a verse al iniciar sesión en este teléfono.")
          },
          color = TextSecondary,
          fontSize = 13.sp,
          lineHeight = 18.sp,
        )
      },
      confirmButton = {
        TextButton(onClick = {
          showLogout = false
          vm.signOut()
        }) { Text("Cerrar sesión", color = Danger) }
      },
      dismissButton = {
        TextButton(onClick = { showLogout = false }) { Text("Cancelar", color = TextSecondary) }
      },
    )
  }

  if (showServer) {
    var draft by remember { mutableStateOf(vm.serverUrl) }
    var urlError by remember { mutableStateOf<String?>(null) }
    AlertDialog(
      onDismissRequest = { showServer = false },
      containerColor = Surface1,
      title = { Text("Servidor", color = TextPrimary) },
      text = {
        Column {
          Text(
            "URL del backend. Emulador: http://10.0.2.2:3001/  ·  Teléfono: http://IP_DE_LA_PC:3001/  ·  Producción: https://api.lecmap.app/",
            color = TextSecondary,
            fontSize = 12.sp,
            lineHeight = 17.sp,
          )
          Spacer(Modifier.height(10.dp))
          OutlinedTextField(
            value = draft,
            onValueChange = {
              draft = it
              urlError = null
            },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            label = { Text("URL") },
            isError = urlError != null,
            supportingText = {
              if (urlError != null) Text(urlError!!, color = Danger, fontSize = 11.sp)
            },
            colors = fieldColors(),
          )
        }
      },
      confirmButton = {
        TextButton(onClick = {
          val err = vm.updateServerUrl(draft)
          if (err == null) showServer = false else urlError = err
        }) { Text("Guardar") }
      },
      dismissButton = {
        TextButton(onClick = { showServer = false }) { Text("Cancelar", color = TextSecondary) }
      },
    )
  }
}

@Composable
private fun Header(
  recording: Boolean,
  serverUrl: String,
  busy: Boolean,
  email: String,
  onToggle: () -> Unit,
  onServer: () -> Unit,
  onLogout: () -> Unit,
) {
  Column(Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text(
          "Lecmap",
          color = Accent,
          fontSize = 24.sp,
          fontWeight = FontWeight.Bold,
        )
        Text(
          "Tus clases, en un mapa",
          color = TextSecondary,
          fontSize = 10.sp,
        )
      }
      Button(
        onClick = onToggle,
        enabled = !busy,
        colors = ButtonDefaults.buttonColors(
          containerColor = if (recording) Danger else Accent,
          contentColor = if (recording) Color.White else OnAccent,
        ),
      ) {
        Text(if (recording) "■  Detener" else "●  Grabar", fontWeight = FontWeight.Bold)
      }
    }
    Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(
        email.ifBlank { serverUrl },
        color = TextSecondary,
        fontSize = 10.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      Text(
        "Cambiar servidor",
        color = Accent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.clickable(onClick = onServer).padding(start = 8.dp),
      )
      Text(
        "·",
        color = TextSecondary,
        fontSize = 10.sp,
        modifier = Modifier.padding(horizontal = 6.dp),
      )
      Text(
        "Salir",
        color = Danger,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.clickable(onClick = onLogout),
      )
    }
  }
}

@Composable
private fun SearchRow(vm: AppViewModel) {
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    OutlinedTextField(
      value = vm.query,
      onValueChange = { vm.query = it },
      modifier = Modifier.weight(1f),
      singleLine = true,
      placeholder = { Text("Buscar en transcripciones…", color = TextSecondary, fontSize = 13.sp) },
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
      keyboardActions = KeyboardActions(onSearch = { vm.search() }),
      colors = fieldColors(),
    )
    Spacer(Modifier.width(8.dp))
    Button(onClick = { vm.search() }) { Text("Buscar") }
  }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
  focusedBorderColor = Accent,
  unfocusedBorderColor = BorderCol,
  focusedTextColor = TextPrimary,
  unfocusedTextColor = TextPrimary,
  cursorColor = Accent,
  errorBorderColor = Danger,
  errorLabelColor = Danger,
  errorSupportingTextColor = Danger,
)

@Composable
private fun RecordingCard(
  rec: RecordingDto,
  active: Boolean,
  busy: Boolean,
  onClick: () -> Unit,
  onAnalyze: () -> Unit,
) {
  val needsAnalysis = rec.status != "summarizing" && (rec.status != "ready" || rec.summary.isNullOrBlank())
  Surface(
    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick),
    color = Surface1,
    shape = RoundedCornerShape(12.dp),
    border = BorderStroke(1.dp, if (active) Accent else BorderCol),
  ) {
    Column(Modifier.padding(12.dp)) {
      Text(
        rec.title.orEmpty(),
        color = TextPrimary,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
      )
      Spacer(Modifier.height(3.dp))
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
          rec.status.orEmpty(),
          color = statusColor(rec.status),
          fontSize = 11.sp,
          fontWeight = FontWeight.Bold,
        )
        rec.error?.let { err ->
          Spacer(Modifier.width(8.dp))
          Text(err, color = Danger, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
      if (rec.status == "summarizing") {
        Text(
          "Resumiendo… puede tardar unos minutos",
          color = Accent,
          fontSize = 11.sp,
          modifier = Modifier.padding(top = 4.dp),
        )
      }
      if (needsAnalysis) {
        TextButton(
          onClick = onAnalyze,
          enabled = !busy,
          modifier = Modifier.align(Alignment.End),
          contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
        ) {
          Text(
            if (rec.status == "ready") "Resumir" else "Analizar",
            color = if (busy) TextSecondary else Accent,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
          )
        }
      }
    }
  }
}

@Composable
private fun AudioPlayer(localPath: String?, serverUrl: String?) {
  val path = localPath ?: serverUrl
  val isRemote = localPath == null && serverUrl != null
  var player by remember(path) { mutableStateOf<MediaPlayer?>(null) }
  var playing by remember(path) { mutableStateOf(false) }
  var audioError by remember(path) { mutableStateOf<String?>(null) }

  DisposableEffect(path) {
    onDispose {
      try {
        player?.release()
      } catch (_: Exception) {
      }
      player = null
      playing = false
    }
  }

  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Button(
      onClick = {
        val current = player
        if (current == null) {
          if (path == null) return@Button
          val mp = MediaPlayer()
          try {
            mp.setDataSource(path)
            mp.setOnPreparedListener {
              it.start()
              playing = true
            }
            mp.setOnCompletionListener {
              playing = false
              it.seekTo(0)
            }
            mp.setOnErrorListener { _, what, extra ->
              audioError = "No se pudo reproducir el audio ($what/$extra)"
              playing = false
              true
            }
            mp.prepareAsync()
            player = mp
          } catch (e: Exception) {
            audioError = e.message ?: "No se pudo abrir el audio"
            try {
              mp.release()
            } catch (_: Exception) {
            }
          }
        } else if (playing) {
          current.pause()
          playing = false
        } else {
          current.start()
          playing = true
        }
      },
      enabled = path != null,
    ) { Text(if (playing) "Pausar" else "Reproducir") }

    Spacer(Modifier.width(10.dp))
    Text(
      when {
        path == null -> "Audio no disponible en este dispositivo"
        isRemote -> "Reproduciendo desde el servidor"
        else -> "Audio guardado en el teléfono"
      },
      color = if (path == null) TextSecondary else Accent,
      fontSize = 11.sp,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
  audioError?.let {
    Text(it, color = Danger, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
  }
}

@Composable
private fun Detail(
  rec: RecordingDto,
  vm: AppViewModel,
  question: String,
  onQuestion: (String) -> Unit,
) {
  Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
      OutlinedButton(onClick = { vm.close() }, border = BorderStroke(1.dp, BorderCol)) {
        Text("Cerrar ✕", color = TextPrimary)
      }
    }

    Spacer(Modifier.height(8.dp))
    AudioPlayer(
      localPath = vm.localAudioPath(rec)?.absolutePath,
      serverUrl = vm.serverAudioUrl(rec),
    )
    Spacer(Modifier.height(8.dp))
    Row(
      Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Button(onClick = { vm.analyze(rec) }, enabled = !vm.busy) { Text("Analizar") }
      OutlinedButton(
        onClick = { vm.summarize() },
        enabled = !vm.busy && rec.transcript.orEmpty().isNotEmpty(),
        border = BorderStroke(1.dp, BorderCol),
      ) { Text("Resumir", color = TextPrimary) }
      if (rec.hasLocalAudio) {
        OutlinedButton(
          onClick = { vm.requestReleaseAudio(rec) },
          enabled = !vm.busy,
          border = BorderStroke(1.dp, BorderCol),
        ) { Text("Liberar audio", color = TextPrimary) }
      }
      OutlinedButton(
        onClick = { vm.requestDelete(rec) },
        enabled = !vm.busy,
        border = BorderStroke(1.dp, Danger),
      ) { Text("Eliminar nota", color = Danger) }
    }

    rec.error?.let {
      Text(it, color = Danger, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
    }

    rec.summary?.takeIf { it.isNotBlank() }?.let { summary ->
      Spacer(Modifier.height(16.dp))
      SectionTitle("Resumen")
      Surface(
        color = Surface1,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderCol),
      ) {
        Text(
          summary,
          color = TextSecondary,
          fontSize = 13.sp,
          lineHeight = 19.sp,
          modifier = Modifier.padding(12.dp),
        )
      }
    }

    if (rec.mindmap != null) {
      Spacer(Modifier.height(18.dp))
      SectionTitle("Mapa de ideas")
      MindmapSection(rec.mindmap)
    }

    val segments = rec.transcript.orEmpty()
    if (segments.isNotEmpty()) {
      Spacer(Modifier.height(18.dp))
      TranscriptCard(title = rec.title.orEmpty(), segments = segments)
    }

    Spacer(Modifier.height(18.dp))
    SectionTitle("Preguntar a ApIA")
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      OutlinedTextField(
        value = question,
        onValueChange = onQuestion,
        modifier = Modifier.weight(1f),
        singleLine = true,
        placeholder = {
          Text("Preguntale a ApIA… ¿Cuáles fueron las conclusiones?", color = TextSecondary, fontSize = 13.sp)
        },
        colors = fieldColors(),
      )
      Spacer(Modifier.width(8.dp))
      Button(onClick = { vm.ask(question) }, enabled = !vm.busy) { Text("Preguntar") }
    }

    if (vm.answer.isNotBlank()) {
      Spacer(Modifier.height(8.dp))
      Surface(
        color = Surface1,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderCol),
      ) {
        Text(
          vm.answer,
          color = TextSecondary,
          fontSize = 13.sp,
          lineHeight = 19.sp,
          modifier = Modifier.padding(12.dp),
        )
      }
    }
  }
}

@Composable
private fun TranscriptCard(title: String, segments: List<SegmentDto>) {
  val context = LocalContext.current
  var exportTimes by remember { mutableStateOf(true) }

  fun shareTranscript() {
    val extension = if (exportTimes) "csv" else "txt"
    val body = transcriptCsv(segments, exportTimes)
    val dir = File(context.cacheDir, "exports").apply { mkdirs() }
    dir.listFiles()?.forEach { it.delete() }
    val safeTitle = title
      .replace(Regex("[\\\\/:*?\"<>|]+"), "_")
      .trim()
      .take(80)
      .ifBlank { "transcripcion" }
    val file = File(dir, "$safeTitle.$extension")
    file.writeText(body, Charsets.UTF_8)
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_SEND).apply {
      type = if (exportTimes) "text/csv" else "text/plain"
      putExtra(Intent.EXTRA_STREAM, uri)
      putExtra(Intent.EXTRA_SUBJECT, title.ifBlank { "Transcripción" })
      clipData = ClipData.newRawUri("transcripcion", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "Compartir transcripción"))
  }

  Column(Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Text(
        "Transcripción",
        color = TextPrimary,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.weight(1f),
      )
      Checkbox(checked = exportTimes, onCheckedChange = { exportTimes = it })
      Text("Tiempos", color = TextSecondary, fontSize = 11.sp)
      Spacer(Modifier.width(4.dp))
      OutlinedButton(
        onClick = { shareTranscript() },
        enabled = segments.isNotEmpty(),
        border = BorderStroke(1.dp, BorderCol),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
      ) { Text("Exportar", color = TextPrimary, fontSize = 12.sp) }
    }

    Spacer(Modifier.height(6.dp))
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = Surface1,
      shape = RoundedCornerShape(12.dp),
      border = BorderStroke(1.dp, BorderCol),
    ) {
      Column {
        segments.forEachIndexed { index, segment ->
          Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(
              fmtTimestamp(segment.start ?: 0.0),
              color = Accent,
              fontSize = 11.sp,
              fontFamily = FontFamily.Monospace,
              fontWeight = FontWeight.Bold,
              modifier = Modifier.width(74.dp),
            )
            Column(Modifier.weight(1f)) {
              segment.speaker?.takeIf { it.isNotBlank() }?.let { speaker ->
                Text(speaker, color = Accent2, fontSize = 10.sp, fontWeight = FontWeight.Bold)
              }
              Text(
                segment.text.orEmpty(),
                color = TextSecondary,
                fontSize = 13.sp,
                lineHeight = 18.sp,
              )
            }
          }
          if (index < segments.lastIndex) HorizontalDivider(color = BorderCol)
        }
      }
    }
  }
}

@Composable
private fun SectionTitle(text: String) {
  Text(
    text,
    color = TextPrimary,
    fontSize = 13.sp,
    fontWeight = FontWeight.Bold,
    modifier = Modifier.padding(bottom = 8.dp),
  )
}

@Composable
private fun ErrorBanner(message: String, onClose: () -> Unit) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = Danger.copy(alpha = 0.12f),
    shape = RoundedCornerShape(10.dp),
    border = BorderStroke(1.dp, Danger.copy(alpha = 0.4f)),
  ) {
    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(message, color = Danger, fontSize = 12.sp, modifier = Modifier.weight(1f))
      TextButton(onClick = onClose) { Text("✕", color = Danger) }
    }
  }
}

private fun statusColor(status: String?): Color = when (status) {
  "ready" -> GreenOk
  "error" -> Danger
  "summarizing", "transcribing", "queued" -> Accent
  else -> TextSecondary
}

private fun fmtTimestamp(seconds: Double): String {
  val total = seconds.toInt().coerceAtLeast(0)
  return String.format(Locale.US, "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
}

private fun csvCell(value: String): String = "\"" + value.replace("\"", "\"\"") + "\""

private fun transcriptCsv(segments: List<SegmentDto>, withTimes: Boolean): String {
  if (!withTimes) return segments.joinToString("\n") { it.text.orEmpty() }
  return buildString {
    append('\uFEFF')
    append("\"Tiempo\",\"Transcripción\"\r\n")
    for (segment in segments) {
      append(csvCell(fmtTimestamp(segment.start ?: 0.0)))
      append(',')
      append(csvCell(segment.text.orEmpty()))
      append("\r\n")
    }
  }
}
