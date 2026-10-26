package com.notasia.clone

import com.google.gson.annotations.SerializedName
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Response
import retrofit2.http.*

// ---------- Supabase Auth REST API ----------

data class SupabaseConfig(
  val url: String,
  val anonKey: String,
)

data class SignUpReq(val email: String, val password: String)
data class SignInReq(val email: String, val password: String)

data class AuthRes(
  @SerializedName("access_token") val accessToken: String,
  @SerializedName("refresh_token") val refreshToken: String,
  @SerializedName("expires_in") val expiresIn: Int,
  @SerializedName("token_type") val tokenType: String,
  @SerializedName("user") val user: AuthUser? = null,
)

data class AuthUser(
  val id: String,
  val email: String? = null,
)

data class AuthError(val error_description: String? = null, val error: String? = null) {
  val message: String get() = error_description ?: error ?: "Error de autenticación"
}

interface SupabaseAuthApi {
  @POST("auth/v1/signup")
  suspend fun signUp(@Body body: SignUpReq): Response<AuthRes>

  @POST("auth/v1/token?grant_type=password")
  suspend fun signIn(@Body body: SignInReq): Response<AuthRes>

  @POST("auth/v1/logout")
  suspend fun signOut(@Header("Authorization") bearer: String): Response<Unit>

  @FormUrlEncoded
  @POST("auth/v1/token?grant_type=refresh_token")
  suspend fun refresh(@Field("refresh_token") refreshToken: String): Response<AuthRes>
}

/**
 * Cliente de autenticación contra Supabase Auth (REST).
 * No depende de la librería supabase-kt: usa el mismo Retrofit/OkHttp del proyecto.
 */
object SupabaseAuth {
  // Se configuran desde Ajustes o desde BuildConfig en el futuro.
  @Volatile var config: SupabaseConfig? = null

  private var cachedApi: SupabaseAuthApi? = null
  private var cachedUrl: String? = null

  private val client = okhttp3.OkHttpClient.Builder()
    .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
    .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
    .build()

  private fun api(): SupabaseAuthApi? {
    val cfg = config ?: return null
    val base = if (cfg.url.endsWith("/")) cfg.url else "${cfg.url}/"
    val existing = cachedApi
    if (existing != null && cachedUrl == base) return existing

    val built = retrofit2.Retrofit.Builder()
      .baseUrl(base)
      .client(client)
      .addConverterFactory(retrofit2.converter.gson.GsonConverterFactory.create())
      .build()
      .create(SupabaseAuthApi::class.java)

    cachedUrl = base
    cachedApi = built
    return built
  }

  fun authHeader(token: String): String = "Bearer $token"

  /** Registra un usuario nuevo. Devuelve AuthRes o lanza AuthException. */
  suspend fun signUp(email: String, password: String): AuthRes {
    val a = api() ?: throw AuthException("Supabase no configurado")
    val r = a.signUp(SignUpReq(email, password))
    if (!r.isSuccessful) throw AuthException(parseError(r))
    return r.body() ?: throw AuthException("Respuesta vacía del servidor")
  }

  /** Login con email+password. */
  suspend fun signIn(email: String, password: String): AuthRes {
    val a = api() ?: throw AuthException("Supabase no configurado")
    val r = a.signIn(SignInReq(email, password))
    if (!r.isSuccessful) throw AuthException(parseError(r))
    return r.body() ?: throw AuthException("Respuesta vacía del servidor")
  }

  /** Cierra la sesión en el servidor. */
  suspend fun signOut(accessToken: String) {
    val a = api() ?: return
    try { a.signOut(authHeader(accessToken)) } catch (_: Exception) { /* best-effort */ }
  }

  /** Refresca el access token usando el refresh token. */
  suspend fun refresh(refreshToken: String): AuthRes {
    val a = api() ?: throw AuthException("Supabase no configurado")
    val r = a.refresh(refreshToken)
    if (!r.isSuccessful) throw AuthException(parseError(r))
    return r.body() ?: throw AuthException("Respuesta vacía del servidor")
  }

  private fun parseError(r: Response<*>): String {
    return try {
      val err = com.google.gson.Gson().fromJson(r.errorBody()?.string(), AuthError::class.java)
      err.message
    } catch (_: Exception) {
      "HTTP ${r.code()}"
    }
  }
}

class AuthException(message: String) : Exception(message)
