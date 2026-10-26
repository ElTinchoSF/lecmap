package com.notasia.clone

import org.junit.Assert.*
import org.junit.Test

/** Regression tests for S6: server URL validation (Net.check). */
class NetCheckTest {

  @Test
  fun `rejects the slash-instead-of-colon port typo`() {
    val result = Net.check("http://127.0.0.1/3001/")
    assertTrue(result is ServerUrl.Invalid)
    assertTrue((result as ServerUrl.Invalid).reason.contains("puerto"))
  }

  @Test
  fun `rejects unparseable input`() {
    assertTrue(Net.check("not a url") is ServerUrl.Invalid)
    assertTrue(Net.check("http://") is ServerUrl.Invalid)
  }

  @Test
  fun `accepts bare host with port`() {
    val result = Net.check("192.168.0.10:3001")
    assertEquals(ServerUrl.Valid("http://192.168.0.10:3001/"), result)
  }

  @Test
  fun `accepts valid https URL without port`() {
    val result = Net.check("https://api.lecmap.app/")
    assertEquals(ServerUrl.Valid("https://api.lecmap.app/"), result)
  }

  @Test
  fun `empty input falls back to default`() {
    assertEquals(ServerUrl.Valid(Net.DEFAULT_BASE_URL), Net.check("  "))
  }

  @Test
  fun `normalize falls back to default on invalid input`() {
    assertEquals(Net.DEFAULT_BASE_URL, Net.normalize("http://127.0.0.1/3001/"))
  }
}
