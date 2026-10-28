package com.notasia.clone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

class MindmapNormalizeTest {

  private fun topicsSection() = MindmapDto(
    title = "Cinemática",
    layout = "topics",
    topics = listOf(
      MindTopicDto(
        title = "Movimiento rectilíneo",
        branches = listOf(MindBranchDto(label = "Velocidad", points = listOf("v = dx/dt"))),
      ),
    ),
  )

  private fun stepsSection() = MindmapDto(
    title = "Método de Euler",
    layout = "steps",
    steps = listOf(MindStepDto(label = "Paso 1"), MindStepDto(label = "Paso 2")),
  )

  @Test
  fun `v2 sections se normalizan cada una con su propio layout`() {
    val doc = normalizeMindmap(
      MindmapDto(title = "Clase de Física", sections = listOf(topicsSection(), stepsSection())),
    )
    assertNotNull(doc)
    assertEquals("Clase de Física", doc!!.title)
    assertEquals(2, doc.sections.size)
    assertEquals(MindLayout.TOPICS, doc.sections[0].layout)
    assertEquals("Cinemática", doc.sections[0].title)
    assertEquals("Velocidad", doc.sections[0].topics[0].branches[0].label)
    assertEquals(MindLayout.STEPS, doc.sections[1].layout)
    assertEquals("Método de Euler", doc.sections[1].title)
    assertEquals(2, doc.sections[1].steps.size)
  }

  @Test
  fun `v2 conserva el orden de las secciones`() {
    val doc = normalizeMindmap(
      MindmapDto(
        title = "Clase",
        sections = listOf(
          MindmapDto(
            title = "B",
            layout = "glossary",
            terms = listOf(MindTermDto(term = "Termino", definition = "Definición")),
          ),
          MindmapDto(title = "A", layout = "steps", steps = listOf(MindStepDto(label = "Paso"))),
        ),
      ),
    )
    assertEquals(listOf("B", "A"), doc!!.sections.map { it.title })
  }

  @Test
  fun `v2 descarta secciones sin datos validos`() {
    val doc = normalizeMindmap(
      MindmapDto(
        title = "Clase",
        sections = listOf(
          MindmapDto(title = "Vacía", layout = "comparison"),
          MindmapDto(
            title = "Glosario",
            layout = "glossary",
            terms = listOf(MindTermDto(term = "A", definition = "def a")),
          ),
        ),
      ),
    )
    assertEquals(1, doc!!.sections.size)
    assertEquals(MindLayout.GLOSSARY, doc.sections[0].layout)
  }

  @Test
  fun `v2 devuelve null si ninguna seccion es valida`() {
    val doc = normalizeMindmap(
      MindmapDto(title = "Clase", sections = listOf(MindmapDto(title = "Nada", layout = "steps"))),
    )
    assertNull(doc)
  }

  @Test
  fun `formato viejo single-layout se envuelve como una seccion`() {
    val doc = normalizeMindmap(
      MindmapDto(
        title = "Clase",
        layout = "steps",
        steps = listOf(MindStepDto(label = "Preparar"), MindStepDto(label = "Ejecutar")),
      ),
    )
    assertNotNull(doc)
    assertEquals(1, doc!!.sections.size)
    assertEquals(MindLayout.STEPS, doc.sections[0].layout)
    assertEquals(2, doc.sections[0].steps.size)
  }

  @Test
  fun `formato viejo con branches cae a topics`() {
    val doc = normalizeMindmap(
      MindmapDto(
        title = "Clase",
        branches = listOf(MindBranchDto(label = "Tema 1"), MindBranchDto(label = "Tema 2")),
      ),
    )
    assertEquals(MindLayout.TOPICS, doc!!.sections[0].layout)
    assertEquals(2, doc.sections[0].topics[0].branches.size)
  }

  @Test
  fun `null devuelve null`() {
    assertNull(normalizeMindmap(null))
  }
}
