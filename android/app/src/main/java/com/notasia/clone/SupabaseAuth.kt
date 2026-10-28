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
// GoTrue exige JSON en el body: form-urlencoded responde 400 bad_json
// ("Could not parse request body as JSON") y el refresh nunca funcionaba.
data class RefreshReq(@SerializedName("refresh_token") val refreshToken: String)
data class PkceExchangeReq(
  @SerializedName("auth_code") val authCode: String,
  @SerializedName("code_verifier") val codeVerifier: String,
)

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

// GoTrue devuelve errores con code/error_code/msg — hay que mapearlos todos o
// el fallo se muestra como "Error de autenticación" sin diagnóstico posible.
data class AuthError(
  val error_description: String? = null,
  val error: String? = null,
  val msg: String? = null,
  val error_code: String? = null,
) {
  val message: String
    get() = error_description ?: error ?: msg
      ?: error_code?.let { "Error de autenticación ($it)" }
      ?: "Error de autenticación"
}

interface SupabaseAuthApi {
  @POST("auth/v1/signup")
  suspend fun signUp(@Body body: SignUpReq): Response<AuthRes>

  @POST("auth/v1/token?grant_type=password")
  suspend fun signIn(@Body body: SignInReq): Response<AuthRes>

  @POST("auth/v1/logout")
  suspend fun signOut(@Header("Authorization") bearer: String): Response<Unit>

  @POST("auth/v1/token?grant_type=refresh_token")
  suspend fun refresh(@Body body: RefreshReq): Response<AuthRes>

  // GoTrue sólo acepta grant_type: password|refresh_token|id_token|pkce|web3.
  // "pkce_exchange" responde 400 unsupported_grant_type (verificado en vivo
  // contra el proyecto alojado el 2026-10-28); el intercambio es "pkce".
  @POST("auth/v1/token?grant_type=pkce")
  suspend fun pkceExchange(@Body body: PkceExchangeReq): Response<AuthRes>
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
    .addInterceptor { chain ->
      val cfg = config
      val request = if (cfg != null) {
        chain.request().newBuilder()
          .header("apikey", cfg.anonKey)
          .build()
      } else {
        chain.request()
      }
      chain.proceed(request)
    }
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
    android.util.Log.d("SupabaseAuth", "signIn → POST auth/v1/token?grant_type=password")
    val r = a.signIn(SignInReq(email, password))
    android.util.Log.d("SupabaseAuth", "signIn response: ${r.code()} success=${r.isSuccessful}")
    if (!r.isSuccessful) {
      val body = try { r.errorBody()?.string() } catch (_: Exception) { null }
      android.util.Log.e("SupabaseAuth", "signIn error body: $body")
      throw AuthException(parseError(r))
    }
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
    val r = a.refresh(RefreshReq(refreshToken))
    if (!r.isSuccessful) throw AuthException(parseError(r))
    return r.body() ?: throw AuthException("Respuesta vacía del servidor")
  }

  /** S3: intercambia el `code` del callback OAuth por la sesión (PKCE). */
  suspend fun pkceExchange(authCode: String, codeVerifier: String): AuthRes {
    val a = api() ?: throw AuthException("Supabase no configurado")
    val r = a.pkceExchange(PkceExchangeReq(authCode, codeVerifier))
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
