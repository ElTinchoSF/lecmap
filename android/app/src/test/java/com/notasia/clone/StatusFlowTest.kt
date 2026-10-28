package com.notasia.clone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusFlowTest {

  @Test
  fun `estados en curso devuelven true`() {
    assertTrue(isServerProcessing("summarizing"))
    assertTrue(isServerProcessing("transcribing"))
    assertTrue(isServerProcessing("queued"))
  }

  @Test
  fun `estados terminales devuelven false`() {
    assertFalse(isServerProcessing("ready"))
    assertFalse(isServerProcessing("error"))
    assertFalse(isServerProcessing(""))
  }
}
