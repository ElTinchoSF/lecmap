package com.notasia.clone

import com.google.gson.annotations.SerializedName
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.MultipartBody
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.*
import java.util.concurrent.TimeUnit

/**
 * Cambiar por la IP de la PC cuando se prueba en un dispositivo físico.
 * Emulador: 10.0.2.2 apunta al localhost de la máquina.
 */
const val BASE_URL = "http://10.0.2.2:3001/"

data class SegmentDto(
  val start: Double? = null,
  val end: Double? = null,
  val speaker: String? = null,
  val text: String? = null,
)

data class RecordingDto(
  val id: String? = null,
  val title: String? = null,
  val status: String? = null,
  val error: String? = null,
  val audioPath: String? = null,
  val summary: String? = null,
  val mindmap: MindmapDto? = null,
  val transcript: List<SegmentDto>? = null,
)

data class AskReq(val question: String)
data class AskRes(val answer: String? = null)
data class SummarizeReq(val template: String = "class")

interface Api {
  @GET("recordings")
  suspend fun list(@Query("q") q: String = ""): List<RecordingDto>

  @GET("recordings/{id}")
  suspend fun get(@Path("id") id: String): RecordingDto

  @Multipart
  @POST("recordings")
  suspend fun upload(
    @Part audio: MultipartBody.Part,
    @Part("title") title: RequestBody,
  ): RecordingDto

  @POST("recordings/{id}/transcribe")
  suspend fun transcribe(@Path("id") id: String): RecordingDto

  @POST("recordings/{id}/summarize")
  suspend fun summarize(@Path("id") id: String, @Body body: SummarizeReq): RecordingDto

  @POST("recordings/{id}/ask")
  suspend fun ask(@Path("id") id: String, @Body body: AskReq): AskRes

  @DELETE("recordings/{id}")
  suspend fun delete(@Path("id") id: String): Response<Unit>
}

object Net {
  const val DEFAULT_BASE_URL = "http://10.0.2.2:3001/"

  private var cachedUrl: String? = null
  private var cachedApi: Api? = null

  private val client = OkHttpClient.Builder()
    .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(180, TimeUnit.SECONDS)
    .writeTimeout(180, TimeUnit.SECONDS)
    .build()

  /** Acepta "192.168.0.10:3001", "http://..." o una URL completa. */
  fun normalize(url: String): String {
    val trimmed = url.trim()
    if (trimmed.isEmpty()) return DEFAULT_BASE_URL
    val withScheme =
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed
      else "http://$trimmed"
    return if (withScheme.endsWith("/")) withScheme else "$withScheme/"
  }

  /** Reutiliza Retrofit mientras la URL no cambie. */
  @Synchronized
  fun api(url: String = DEFAULT_BASE_URL): Api {
    val normalized = normalize(url)
    val existing = cachedApi
    if (existing != null && cachedUrl == normalized) return existing

    val built = Retrofit.Builder()
      .baseUrl(normalized)
      .client(client)
      .addConverterFactory(GsonConverterFactory.create())
      .build()
      .create(Api::class.java)

    cachedUrl = normalized
    cachedApi = built
    return built
  }
}
