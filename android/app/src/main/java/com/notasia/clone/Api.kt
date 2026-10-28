package com.notasia.clone

import com.google.gson.annotations.SerializedName
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
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
  // Campos locales: no vienen del backend, los completa la app al mezclar
  // la nota del servidor con su copia en el teléfono.
  val localId: String? = null,
  val serverId: String? = null,
  val hasLocalAudio: Boolean = false,
)

data class RecordingListDto(
  val items: List<RecordingDto> = emptyList(),
  val total: Int = 0,
  val limit: Int = 50,
  val offset: Int = 0,
)

data class AskReq(val question: String)
data class AskRes(val answer: String? = null)
  data class SummarizeReq(val template: String = "class")

  data class RenameReq(val title: String)

interface Api {
  @GET("recordings")
  suspend fun list(
    @Query("q") q: String = "",
    @Query("limit") limit: Int = 50,
    @Query("offset") offset: Int = 0,
  ): RecordingListDto

  @GET("recordings/{id}")
  suspend fun get(@Path("id") id: String): RecordingDto

  @Multipart
  @POST("recordings")
  suspend fun upload(
    @Part audio: MultipartBody.Part,
    @Part("title") title: RequestBody,
  ): RecordingDto

  @Multipart
  @POST("recordings/{id}/audio")
  suspend fun uploadAudio(
    @Path("id") id: String,
    @Part audio: MultipartBody.Part,
  ): RecordingDto

  @POST("recordings/{id}/transcribe")
  suspend fun transcribe(@Path("id") id: String): RecordingDto

  @POST("recordings/{id}/summarize")
  suspend fun summarize(@Path("id") id: String, @Body body: SummarizeReq): RecordingDto

  @POST("recordings/{id}/ask")
  suspend fun ask(@Path("id") id: String, @Body body: AskReq): AskRes

  @DELETE("recordings/{id}")
  suspend fun delete(@Path("id") id: String): Response<Unit>

  /** S4: renombrar la nota en el servidor (ruta nueva PATCH /recordings/:id). */
  @PATCH("recordings/{id}")
  suspend fun rename(@Path("id") id: String, @Body body: RenameReq): RecordingDto
}

/** Resultado de validar la URL del backend. */
sealed interface ServerUrl {
  data class Valid(val url: String) : ServerUrl
  data class Invalid(val reason: String) : ServerUrl
}

object Net {
  const val DEFAULT_BASE_URL = "http://10.0.2.2:3001/"

  /** Token opcional de la API. Se lee en cada request, así el cambio es inmediato. */
  @Volatile
  var apiToken: String = ""

  private var cachedUrl: String? = null
  private var cachedApi: Api? = null

  private val client = OkHttpClient.Builder()
    .addInterceptor { chain ->
      val token = apiToken.trim()
      val request = if (token.isEmpty()) chain.request()
      else chain.request().newBuilder().header("Authorization", "Bearer $token").build()
      chain.proceed(request)
    }
    .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(180, TimeUnit.SECONDS)
    .writeTimeout(180, TimeUnit.SECONDS)
    .build()

  /**
   * Valida y normaliza la URL del servidor.
   * Acepta "192.168.0.10:3001", "http://..." o una URL completa.
   * Rechaza lo que no parsea como http(s) y el typo clásico de puerto:
   * "http://127.0.0.1/3001/" (barra en vez de dos puntos).
   */
  fun check(url: String): ServerUrl {
    val trimmed = url.trim()
    if (trimmed.isEmpty()) return ServerUrl.Valid(DEFAULT_BASE_URL)
    val withScheme =
      if (trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true)) trimmed
      else "http://$trimmed"
    val parsed = withScheme.toHttpUrlOrNull()
      ?: return ServerUrl.Invalid("URL inválida. Usá http:// o https://, por ejemplo http://192.168.0.10:3001/")

    // Sin puerto explícito y con un primer segmento de path numérico: casi seguro
    // es el typo "/" en lugar de ":" (http://127.0.0.1/3001/ en vez de :3001/).
    val authority = withScheme.substringAfter("://", "").substringBefore('/')
    val hostAndPort = authority.substringAfterLast('@')
    val firstSegment = parsed.pathSegments.firstOrNull()
    if (!hostAndPort.contains(':') && firstSegment?.toIntOrNull() != null) {
      return ServerUrl.Invalid(
        "Falta el puerto (:). ¿Quisiste http://${parsed.host}:$firstSegment/?",
      )
    }

    return ServerUrl.Valid(if (withScheme.endsWith("/")) withScheme else "$withScheme/")
  }

  /** Normaliza para uso interno; una URL inválida cae en la por defecto. */
  fun normalize(url: String): String = when (val checked = check(url)) {
    is ServerUrl.Valid -> checked.url
    is ServerUrl.Invalid -> DEFAULT_BASE_URL
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
