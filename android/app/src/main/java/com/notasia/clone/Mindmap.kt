package com.notasia.clone

// ---------- DTOs (tal como llegan del backend) ----------

data class MindBranchDto(
  val label: String? = null,
  val detail: String? = null,
  val points: List<String>? = null,
  val branches: List<MindBranchDto>? = null,
)

data class MindTopicDto(
  val title: String? = null,
  val label: String? = null,
  val branches: List<MindBranchDto>? = null,
)

data class MindItemDto(
  val name: String? = null,
  val label: String? = null,
  val values: List<String>? = null,
)

data class MindStepDto(
  val label: String? = null,
  val detail: String? = null,
  val points: List<String>? = null,
)

data class MindEventDto(
  val date: String? = null,
  val label: String? = null,
  val title: String? = null,
  val detail: String? = null,
  val points: List<String>? = null,
)

data class MindTermDto(
  val term: String? = null,
  val label: String? = null,
  val name: String? = null,
  val definition: String? = null,
  val detail: String? = null,
  val points: List<String>? = null,
)

data class MindCauseDto(
  val label: String? = null,
  val cause: String? = null,
  val detail: String? = null,
  val effects: List<String>? = null,
  val points: List<String>? = null,
)

data class MindProblemDto(
  val label: String? = null,
  val problem: String? = null,
  val detail: String? = null,
  val solutions: List<String>? = null,
  val points: List<String>? = null,
)

data class MindNodeDto(
  val id: String? = null,
  val label: String? = null,
  val detail: String? = null,
  val parent: String? = null,
)

data class MindmapDto(
  val title: String? = null,
  val layout: String? = null,
  val topics: List<MindTopicDto>? = null,
  val dimensions: List<String>? = null,
  val items: List<MindItemDto>? = null,
  val steps: List<MindStepDto>? = null,
  val events: List<MindEventDto>? = null,
  val terms: List<MindTermDto>? = null,
  val causes: List<MindCauseDto>? = null,
  val problems: List<MindProblemDto>? = null,
  // Formatos viejos
  val branches: List<MindBranchDto>? = null,
  val nodes: List<MindNodeDto>? = null,
  val root: String? = null,
  val children: List<MindBranchDto>? = null,
)

// ---------- Modelo normalizado que consume la UI ----------

enum class MindLayout { TOPICS, COMPARISON, STEPS, TIMELINE, GLOSSARY, CAUSE, SOLUTION }

data class MindBranch(
  val label: String,
  val detail: String?,
  val points: List<String>,
  val branches: List<MindBranch>,
)

data class MindTopic(val title: String, val branches: List<MindBranch>)
data class MindItem(val name: String, val values: List<String>)
data class MindStep(val label: String, val detail: String?, val points: List<String>)
data class MindEvent(val date: String?, val label: String, val detail: String?, val points: List<String>)
data class MindTerm(val term: String, val definition: String, val points: List<String>)
data class MindCause(val label: String, val detail: String?, val effects: List<String>)
data class MindProblem(val label: String, val detail: String?, val solutions: List<String>)

data class MindData(
  val title: String,
  val layout: MindLayout,
  val topics: List<MindTopic> = emptyList(),
  val dimensions: List<String> = emptyList(),
  val items: List<MindItem> = emptyList(),
  val steps: List<MindStep> = emptyList(),
  val events: List<MindEvent> = emptyList(),
  val terms: List<MindTerm> = emptyList(),
  val causes: List<MindCause> = emptyList(),
  val problems: List<MindProblem> = emptyList(),
)

private fun text(v: String?): String = v?.trim().orEmpty()
private fun texts(v: List<String>?): List<String> =
  v?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()

private fun toBranches(list: List<MindBranchDto>?, depth: Int = 0): List<MindBranch> {
  if (list == null || depth > 4) return emptyList()
  return list.mapNotNull { b ->
    val label = text(b.label)
    if (label.isEmpty()) null
    else MindBranch(
      label = label,
      detail = b.detail?.trim()?.takeIf { it.isNotEmpty() },
      points = texts(b.points),
      branches = toBranches(b.branches, depth + 1),
    )
  }
}

private data class NodeRow(
  val id: String,
  val label: String,
  val detail: String?,
  val parent: String?,
)

private fun buildTopics(mm: MindmapDto, fallback: String): List<MindTopic> {
  if (!mm.topics.isNullOrEmpty()) {
    val topics = mm.topics.mapIndexedNotNull { i, t ->
      val branches = toBranches(t.branches)
      val title = text(t.title).ifEmpty { text(t.label) }
        .ifEmpty { branches.firstOrNull()?.label ?: "" }
      if (branches.isEmpty()) null else MindTopic(title.ifEmpty { "Tema ${i + 1}" }, branches)
    }
    if (topics.isNotEmpty()) return topics
  }

  if (!mm.branches.isNullOrEmpty()) {
    val branches = toBranches(mm.branches)
    if (branches.isNotEmpty()) {
      return listOf(MindTopic(fallback.ifEmpty { branches.first().label }, branches))
    }
  }

  if (!mm.nodes.isNullOrEmpty()) {
    val nodes = mm.nodes.mapIndexedNotNull { i, n ->
      val label = text(n.label)
      if (label.isEmpty()) null
      else NodeRow(
        id = text(n.id).ifEmpty { "n${i + 1}" },
        label = label,
        detail = n.detail?.trim()?.takeIf { it.isNotEmpty() },
        parent = text(n.parent).takeIf { it.isNotEmpty() },
      )
    }

    val ids = nodes.map { it.id }.toSet()
    val children = mutableMapOf<String?, MutableList<NodeRow>>()
    for (n in nodes) {
      val parent = n.parent?.takeIf { ids.contains(it) && it != n.id }
      children.getOrPut(parent) { mutableListOf() }.add(n)
    }

    fun toBranch(n: NodeRow): MindBranch = MindBranch(
      label = n.label,
      detail = n.detail,
      points = emptyList(),
      branches = (children[n.id] ?: emptyList()).map { toBranch(it) },
    )

    val roots = children[null] ?: emptyList()
    val rootKids = if (roots.size == 1) children[roots[0].id] ?: emptyList() else emptyList()
    val baseTitle = fallback.ifEmpty { roots.firstOrNull()?.label ?: "Mapa de ideas" }

    if (roots.size == 1 && rootKids.size >= 2) {
      return listOf(MindTopic(baseTitle, rootKids.map { toBranch(it) }))
    }
    if (roots.size == 1 && nodes.size > 2) {
      return listOf(
        MindTopic(baseTitle, nodes.map { MindBranch(it.label, it.detail, emptyList(), emptyList()) })
      )
    }
    return listOf(MindTopic(baseTitle, roots.map { toBranch(it) }))
  }

  if (mm.root != null || mm.children != null) {
    val root = text(mm.root).ifEmpty { text(mm.title) }.ifEmpty { "Mapa de ideas" }
    val branches = toBranches(mm.children)
    return if (branches.isEmpty()) emptyList() else listOf(MindTopic(root, branches))
  }

  return emptyList()
}

/**
 * Elige el layout pedido por la IA; si no trae datos válidos prueba los demás
 * y, como último recurso, cae al mapa de temas. Misma lógica que web/backend.
 */
fun normalizeMindmap(mm: MindmapDto?): MindData? {
  if (mm == null) return null
  val title = text(mm.title)

  val requested = when (mm.layout) {
    "comparison" -> MindLayout.COMPARISON
    "steps" -> MindLayout.STEPS
    "timeline" -> MindLayout.TIMELINE
    "glossary" -> MindLayout.GLOSSARY
    "cause" -> MindLayout.CAUSE
    "solution" -> MindLayout.SOLUTION
    else -> MindLayout.TOPICS
  }

  val builders: Map<MindLayout, () -> MindData?> = mapOf(
    MindLayout.TOPICS to {
      val topics = buildTopics(mm, title)
      if (topics.isEmpty()) null
      else MindData(title.ifEmpty { topics.first().title }, MindLayout.TOPICS, topics = topics)
    },
    MindLayout.COMPARISON to {
      val items = (mm.items ?: emptyList()).mapNotNull { it ->
        val name = text(it.name).ifEmpty { text(it.label) }
        if (name.isEmpty()) null else MindItem(name, it.values ?: emptyList())
      }
      if (items.isEmpty()) null
      else MindData(
        title.ifEmpty { "Mapa de ideas" },
        MindLayout.COMPARISON,
        dimensions = texts(mm.dimensions),
        items = items,
      )
    },
    MindLayout.STEPS to {
      val steps = (mm.steps ?: emptyList()).mapNotNull { s ->
        val label = text(s.label)
        if (label.isEmpty()) null
        else MindStep(label, s.detail?.trim()?.takeIf { it.isNotEmpty() }, texts(s.points))
      }
      if (steps.isEmpty()) null
      else MindData(title.ifEmpty { "Mapa de ideas" }, MindLayout.STEPS, steps = steps)
    },
    MindLayout.TIMELINE to {
      val events = (mm.events ?: emptyList()).mapNotNull { e ->
        val label = text(e.label).ifEmpty { text(e.title) }
        if (label.isEmpty()) null
        else MindEvent(
          date = text(e.date).takeIf { it.isNotEmpty() },
          label = label,
          detail = e.detail?.trim()?.takeIf { it.isNotEmpty() },
          points = texts(e.points),
        )
      }
      if (events.isEmpty()) null
      else MindData(title.ifEmpty { "Mapa de ideas" }, MindLayout.TIMELINE, events = events)
    },
    MindLayout.GLOSSARY to {
      val terms = (mm.terms ?: emptyList()).mapNotNull { t ->
        val term = text(t.term).ifEmpty { text(t.label) }.ifEmpty { text(t.name) }
        val definition = text(t.definition).ifEmpty { text(t.detail) }
        if (term.isEmpty() || definition.isEmpty()) null
        else MindTerm(term, definition, texts(t.points))
      }
      if (terms.isEmpty()) null
      else MindData(title.ifEmpty { "Mapa de ideas" }, MindLayout.GLOSSARY, terms = terms)
    },
    MindLayout.CAUSE to {
      val causes = (mm.causes ?: emptyList()).mapNotNull { c ->
        val label = text(c.label).ifEmpty { text(c.cause) }
        if (label.isEmpty()) null
        else MindCause(
          label = label,
          detail = c.detail?.trim()?.takeIf { it.isNotEmpty() },
          effects = texts(c.effects ?: c.points),
        )
      }
      if (causes.isEmpty()) null
      else MindData(title.ifEmpty { "Mapa de ideas" }, MindLayout.CAUSE, causes = causes)
    },
    MindLayout.SOLUTION to {
      val problems = (mm.problems ?: emptyList()).mapNotNull { p ->
        val label = text(p.label).ifEmpty { text(p.problem) }
        if (label.isEmpty()) null
        else MindProblem(
          label = label,
          detail = p.detail?.trim()?.takeIf { it.isNotEmpty() },
          solutions = texts(p.solutions ?: p.points),
        )
      }
      if (problems.isEmpty()) null
      else MindData(title.ifEmpty { "Mapa de ideas" }, MindLayout.SOLUTION, problems = problems)
    },
  )

  val order = listOf(requested) + MindLayout.values().filter { it != requested }
  for (layout in order) {
    val data = builders[layout]?.invoke()
    if (data != null) return data
  }
  return null
}
