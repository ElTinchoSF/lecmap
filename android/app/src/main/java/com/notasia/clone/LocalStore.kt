package com.notasia.clone

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.google.gson.Gson
import java.io.File

/** Nota guardada en el teléfono. El audio vive en filesDir; la fila es el índice. */
data class LocalNote(
  val localId: String,
  val serverId: String? = null,
  val title: String,
  val createdAt: Long,
  val status: String = "local",
  val error: String? = null,
  val audioFile: String? = null,
  val transcript: List<SegmentDto> = emptyList(),
  val summary: String? = null,
  val mindmap: MindmapDto? = null,
)

class LocalStore(context: Context) : SQLiteOpenHelper(context, DB_NAME, null, 1) {
  companion object {
    private const val DB_NAME = "lecmap_local.db"
    private const val TABLE = "local_notes"
  }

  private val gson = Gson()

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE $TABLE (
        local_id TEXT PRIMARY KEY,
        server_id TEXT,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        audio_file TEXT,
        transcript_json TEXT,
        summary TEXT,
        mindmap_json TEXT
      )
      """.trimIndent()
    )
    db.execSQL("CREATE INDEX idx_local_server ON $TABLE(server_id)")
    db.execSQL("CREATE INDEX idx_local_created ON $TABLE(created_at DESC)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // v1: sin migraciones todavía.
  }

  fun list(): List<LocalNote> {
    val out = mutableListOf<LocalNote>()
    readableDatabase.query(
      TABLE, null, null, null, null, null, "created_at DESC",
    ).use { c ->
      while (c.moveToNext()) out.add(fromCursor(c))
    }
    return out
  }

  fun get(localId: String): LocalNote? =
    readableDatabase.query(TABLE, null, "local_id = ?", arrayOf(localId), null, null, null).use { c ->
      if (c.moveToFirst()) fromCursor(c) else null
    }

  fun findByServerId(serverId: String): LocalNote? =
    readableDatabase.query(TABLE, null, "server_id = ?", arrayOf(serverId), null, null, null).use { c ->
      if (c.moveToFirst()) fromCursor(c) else null
    }

  fun upsert(note: LocalNote) {
    writableDatabase.insertWithOnConflict(TABLE, null, values(note), SQLiteDatabase.CONFLICT_REPLACE)
  }

  fun setServerId(localId: String, serverId: String) {
    val v = ContentValues().apply { put("server_id", serverId) }
    writableDatabase.update(TABLE, v, "local_id = ?", arrayOf(localId))
  }

  fun setStatus(localId: String, status: String, error: String?) {
    val v = ContentValues().apply {
      put("status", status)
      if (error == null) putNull("error") else put("error", error)
    }
    writableDatabase.update(TABLE, v, "local_id = ?", arrayOf(localId))
  }

  fun setAudioFile(localId: String, audioFile: String?) {
    val v = ContentValues().apply {
      if (audioFile == null) putNull("audio_file") else put("audio_file", audioFile)
    }
    writableDatabase.update(TABLE, v, "local_id = ?", arrayOf(localId))
  }

  /** Actualiza la copia local con la respuesta del servidor. */
  fun updateFromServer(serverId: String, dto: RecordingDto) {
    val note = findByServerId(serverId) ?: return
    val updated = note.copy(
      title = dto.title ?: note.title,
      status = dto.status ?: note.status,
      error = dto.error,
      transcript = dto.transcript?.takeIf { it.isNotEmpty() } ?: note.transcript,
      summary = dto.summary ?: note.summary,
      mindmap = dto.mindmap ?: note.mindmap,
    )
    upsert(updated)
  }

  fun delete(localId: String) {
    val note = get(localId)
    note?.audioFile?.let { path ->
      try {
        File(path).delete()
      } catch (_: Exception) {
      }
    }
    writableDatabase.delete(TABLE, "local_id = ?", arrayOf(localId))
  }

  fun deleteByServerId(serverId: String) {
    val note = findByServerId(serverId) ?: return
    delete(note.localId)
  }

  private fun values(note: LocalNote): ContentValues = ContentValues().apply {
    put("local_id", note.localId)
    if (note.serverId == null) putNull("server_id") else put("server_id", note.serverId)
    put("title", note.title)
    put("created_at", note.createdAt)
    put("status", note.status)
    if (note.error == null) putNull("error") else put("error", note.error)
    if (note.audioFile == null) putNull("audio_file") else put("audio_file", note.audioFile)
    put("transcript_json", gson.toJson(note.transcript))
    if (note.summary == null) putNull("summary") else put("summary", note.summary)
    if (note.mindmap == null) putNull("mindmap_json") else put("mindmap_json", gson.toJson(note.mindmap))
  }

  private fun fromCursor(c: android.database.Cursor): LocalNote {
    val transcriptJson = c.getString(c.getColumnIndexOrThrow("transcript_json"))
    val mindmapJson = c.getString(c.getColumnIndexOrThrow("mindmap_json"))
    return LocalNote(
      localId = c.getString(c.getColumnIndexOrThrow("local_id")),
      serverId = c.getString(c.getColumnIndexOrThrow("server_id")),
      title = c.getString(c.getColumnIndexOrThrow("title")),
      createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
      status = c.getString(c.getColumnIndexOrThrow("status")),
      error = c.getString(c.getColumnIndexOrThrow("error")),
      audioFile = c.getString(c.getColumnIndexOrThrow("audio_file")),
      transcript = if (transcriptJson.isNullOrBlank()) {
        emptyList()
      } else {
        runCatching {
          gson.fromJson(transcriptJson, Array<SegmentDto>::class.java).toList()
        }.getOrDefault(emptyList())
      },
      summary = c.getString(c.getColumnIndexOrThrow("summary")),
      mindmap = if (mindmapJson.isNullOrBlank()) {
        null
      } else {
        runCatching { gson.fromJson(mindmapJson, MindmapDto::class.java) }.getOrNull()
      },
    )
  }
}
