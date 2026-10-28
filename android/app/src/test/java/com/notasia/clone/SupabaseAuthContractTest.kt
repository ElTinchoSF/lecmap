package com.notasia.clone

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.Body
import retrofit2.http.FormUrlEncoded
import retrofit2.http.POST

/**
 * Regression tests for login-header-google-fixes: GoTrue token contracts (S1/S3).
 *
 * GoTrue /auth/v1/token only accepts JSON bodies and a fixed set of grant
 * types (password, refresh_token, id_token, pkce, web3). Sending anything
 * else (form-urlencoded, grant_type=pkce_exchange) returns 400 and the flow
 * dies silently.
 */
class SupabaseAuthContractTest {
  private val gson = Gson()

  // Kotlin suspend fun compiles with a trailing Continuation parameter, so
  // Class.getMethod with the source signature does not resolve. Match by name.
  private fun apiMethod(name: String) =
    SupabaseAuthApi::class.java.declaredMethods.first { it.name == name }

  private fun sendsJsonBody(name: String): Boolean =
    apiMethod(name).parameterAnnotations.any { anns -> anns.any { it.annotationClass == Body::class } }

  @Test
  fun `refresh grant is refresh_token with a JSON body`() {
    val m = apiMethod("refresh")
    assertEquals("auth/v1/token?grant_type=refresh_token", m.getAnnotation(POST::class.java).value)
    assertTrue("refresh must send @Body JSON, not form fields", sendsJsonBody("refresh"))
    assertNull(m.getAnnotation(FormUrlEncoded::class.java))
  }

  @Test
  fun `RefreshReq serializes the GoTrue field refresh_token`() {
    assertEquals("""{"refresh_token":"RT"}""", gson.toJson(RefreshReq("RT")))
  }

  @Test
  fun `AuthError maps the GoTrue error shape`() {
    val withMsg =
      gson.fromJson("""{"code":400,"error_code":"bad_json","msg":"Could not parse"}""", AuthError::class.java)
    assertEquals("Could not parse", withMsg.message)

    val codeOnly = gson.fromJson("""{"error_code":"over_email_send_rate_limit"}""", AuthError::class.java)
    assertTrue(codeOnly.message.contains("over_email_send_rate_limit"))

    val legacy = gson.fromJson("""{"error_description":"desc"}""", AuthError::class.java)
    assertEquals("desc", legacy.message)
  }

  @Test
  fun `pkce exchange uses the grant type GoTrue accepts`() {
    val m = apiMethod("pkceExchange")
    // Hosted GoTrue responds 400 unsupported_grant_type for pkce_exchange
    // (verified live against wglycndzgxgjtplwrcyq.supabase.co on 2026-10-28).
    assertEquals("auth/v1/token?grant_type=pkce", m.getAnnotation(POST::class.java).value)
    assertTrue(sendsJsonBody("pkceExchange"))
    assertEquals("""{"auth_code":"C","code_verifier":"V"}""", gson.toJson(PkceExchangeReq("C", "V")))
  }
}
