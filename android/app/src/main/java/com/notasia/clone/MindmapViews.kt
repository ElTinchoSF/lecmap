package com.notasia.clone

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun MindmapSection(raw: MindmapDto?) {
  val doc = remember(raw) { normalizeMindmap(raw) } ?: return
  Column(Modifier.fillMaxWidth()) {
    doc.sections.forEachIndexed { i, data ->
      if (i > 0) {
        Spacer(Modifier.height(18.dp))
        HorizontalDivider(color = BorderCol, thickness = 1.dp)
        Spacer(Modifier.height(16.dp))
      }
      LayoutBody(data)
    }
  }
}

@Composable
private fun LayoutBody(data: MindData) {
  when (data.layout) {
    MindLayout.COMPARISON -> ComparisonView(data)
    MindLayout.STEPS -> StepsView(data)
    MindLayout.TIMELINE -> TimelineView(data)
    MindLayout.GLOSSARY -> GlossaryView(data)
    MindLayout.CAUSE -> CauseView(data)
    MindLayout.SOLUTION -> SolutionView(data)
    MindLayout.TOPICS -> TopicsView(data)
  }
}

@Composable
private fun OverallHeader(title: String, count: String) {
  Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(
      title,
      color = TextPrimary,
      fontSize = 14.sp,
      fontWeight = FontWeight.Bold,
      modifier = Modifier.weight(1f),
    )
    if (count.isNotEmpty()) {
      Text(count.uppercase(), color = TextSecondary, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
  }
  HorizontalDivider(color = BorderCol, thickness = 1.dp)
  Spacer(Modifier.height(10.dp))
}

@Composable
private fun InfoCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
  Surface(
    modifier = modifier,
    color = Surface1,
    shape = RoundedCornerShape(12.dp),
    border = BorderStroke(1.dp, BorderCol),
  ) {
    Column(Modifier.padding(12.dp)) { content() }
  }
}

@Composable
private fun Bullets(items: List<String>, color: Color) {
  if (items.isEmpty()) return
  Column(Modifier.padding(top = 6.dp)) {
    items.forEach { item ->
      Text(
        "•  $item",
        color = TextSecondary,
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
        modifier = Modifier.padding(vertical = 1.dp),
      )
    }
  }
}

@Composable
private fun Tag(text: String, color: Color) {
  Box(
    Modifier.clip(RoundedCornerShape(50))
      .background(color.copy(alpha = 0.14f))
      .padding(horizontal = 8.dp, vertical = 2.dp),
  ) {
    Text(
      text.uppercase(),
      color = color,
      fontSize = 9.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
  }
}

@Composable
private fun BranchCard(branch: MindBranch, index: Int) {
  val color = BranchColors[index % BranchColors.size]
  InfoCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        Modifier.size(22.dp).clip(CircleShape).background(color.copy(alpha = 0.18f)),
        contentAlignment = Alignment.Center,
      ) {
        Text("${index + 1}", color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold)
      }
      Spacer(Modifier.width(8.dp))
      Text(branch.label, color = color, fontSize = 14.sp, fontWeight = FontWeight.Bold, lineHeight = 18.sp)
    }
    branch.detail?.let {
      Text(
        it,
        color = TextSecondary,
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
        modifier = Modifier.padding(top = 6.dp),
      )
    }
    Bullets(branch.points, color)
    if (branch.branches.isNotEmpty()) {
      Column(
        Modifier.padding(start = 10.dp, top = 8.dp)
          .border(1.dp, color.copy(alpha = 0.22f), RoundedCornerShape(8.dp))
          .padding(8.dp),
      ) {
        branch.branches.forEachIndexed { i, sub -> BranchCard(sub, index + i + 1) }
      }
    }
  }
}

@Composable
private fun TopicRoot(title: String) {
  Box(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp))
      .background(Brush.linearGradient(listOf(Accent, Accent2)))
      .padding(horizontal = 16.dp, vertical = 14.dp),
    contentAlignment = Alignment.Center,
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(
        "TEMA CENTRAL",
        color = OnAccent.copy(alpha = 0.7f),
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.4.sp,
      )
      Spacer(Modifier.height(4.dp))
      Text(
        title,
        color = OnAccent,
        fontSize = 16.sp,
        fontWeight = FontWeight.Bold,
        textAlign = TextAlign.Center,
      )
    }
  }
}

@Composable
private fun TopicsView(data: MindData) {
  OverallHeader(data.title, "${data.topics.size} temas centrales")
  data.topics.forEachIndexed { ti, topic ->
    if (ti > 0) Spacer(Modifier.height(16.dp))
    TopicRoot(topic.title)
    Spacer(Modifier.height(8.dp))
    topic.branches.forEachIndexed { i, b -> BranchCard(b, i) }
  }
}

@Composable
private fun ComparisonView(data: MindData) {
  val dims = if (data.dimensions.isNotEmpty()) {
    data.dimensions
  } else {
    val max = data.items.maxOfOrNull { it.values.size } ?: 0
    List(max) { "Aspecto ${it + 1}" }
  }
  OverallHeader(data.title, "${data.items.size} elementos · comparación")

  Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
    Column {
      Row {
        TableCell(data.title.ifEmpty { "Elemento" }, header = true, bold = true, width = 140.dp)
        dims.forEach { TableCell(it, header = true, bold = false, width = 170.dp) }
      }
      data.items.forEach { item ->
        Row {
          TableCell(item.name, header = false, bold = true, width = 140.dp)
          dims.indices.forEach { c ->
            TableCell(item.values.getOrNull(c).orEmpty(), header = false, bold = false, width = 170.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun TableCell(text: String, header: Boolean, bold: Boolean, width: Dp) {
  Box(
    Modifier.width(width)
      .heightIn(min = 44.dp)
      .background(if (header) Surface2 else Surface1)
      .border(0.5.dp, BorderCol)
      .padding(8.dp),
  ) {
    Text(
      text,
      color = if (header) Accent else TextSecondary,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      fontWeight = if (header || bold) FontWeight.Bold else FontWeight.Normal,
    )
  }
}

@Composable
private fun StepsView(data: MindData) {
  OverallHeader(data.title, "${data.steps.size} pasos")
  data.steps.forEachIndexed { i, step ->
    val color = BranchColors[i % BranchColors.size]
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
      Column(
        Modifier.width(34.dp).fillMaxHeight().drawBehind {
          if (i < data.steps.size - 1) {
            drawLine(
              color = color.copy(alpha = 0.35f),
              start = Offset(size.width / 2f, 34.dp.toPx()),
              end = Offset(size.width / 2f, size.height),
              strokeWidth = 2.dp.toPx(),
            )
          }
        },
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Box(
          Modifier.size(28.dp).clip(CircleShape).background(color),
          contentAlignment = Alignment.Center,
        ) {
          Text("${i + 1}", color = OnAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
      }
      Spacer(Modifier.width(8.dp))
      StepCard(step, color, Modifier.weight(1f))
    }
  }
}

@Composable
private fun StepCard(step: MindStep, color: Color, modifier: Modifier) {
  Surface(
    modifier = modifier.padding(vertical = 4.dp),
    color = Surface1,
    shape = RoundedCornerShape(12.dp),
    border = BorderStroke(1.dp, BorderCol),
  ) {
    Column(Modifier.padding(12.dp)) {
      Text(step.label, color = color, fontSize = 14.sp, fontWeight = FontWeight.Bold)
      step.detail?.let {
        Text(
          it,
          color = TextSecondary,
          fontSize = 12.5.sp,
          lineHeight = 17.sp,
          modifier = Modifier.padding(top = 4.dp),
        )
      }
      Bullets(step.points, color)
    }
  }
}

@Composable
private fun TimelineView(data: MindData) {
  OverallHeader(data.title, "${data.events.size} momentos")
  data.events.forEachIndexed { i, event ->
    val color = BranchColors[i % BranchColors.size]
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
      Column(
        Modifier.width(22.dp).fillMaxHeight().drawBehind {
          if (i < data.events.size - 1) {
            drawLine(
              color = color.copy(alpha = 0.35f),
              start = Offset(size.width / 2f, 18.dp.toPx()),
              end = Offset(size.width / 2f, size.height),
              strokeWidth = 2.dp.toPx(),
            )
          }
        },
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Box(Modifier.size(12.dp).clip(CircleShape).background(color))
      }
      Spacer(Modifier.width(8.dp))
      Surface(
        modifier = Modifier.weight(1f).padding(vertical = 4.dp),
        color = Surface1,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, BorderCol),
      ) {
        Column(Modifier.padding(12.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            event.date?.let {
              Box(
                Modifier.clip(RoundedCornerShape(50))
                  .background(color.copy(alpha = 0.16f))
                  .padding(horizontal = 8.dp, vertical = 2.dp),
              ) {
                Text(it, color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold)
              }
              Spacer(Modifier.width(8.dp))
            }
            Text(
              event.label,
              color = TextPrimary,
              fontSize = 14.sp,
              fontWeight = FontWeight.Bold,
              modifier = Modifier.weight(1f),
            )
          }
          event.detail?.let {
            Text(
              it,
              color = TextSecondary,
              fontSize = 12.5.sp,
              lineHeight = 17.sp,
              modifier = Modifier.padding(top = 6.dp),
            )
          }
          Bullets(event.points, color)
        }
      }
    }
  }
}

@Composable
private fun GlossaryView(data: MindData) {
  OverallHeader(data.title, "${data.terms.size} términos")
  data.terms.forEachIndexed { i, term ->
    val color = BranchColors[i % BranchColors.size]
    InfoCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
      Text(term.term, color = color, fontSize = 15.sp, fontWeight = FontWeight.Bold)
      Text(
        term.definition,
        color = TextSecondary,
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
        modifier = Modifier.padding(top = 4.dp),
      )
      Bullets(term.points, color)
    }
  }
}

@Composable
private fun CauseView(data: MindData) {
  OverallHeader(data.title, "${data.causes.size} causas")
  data.causes.forEachIndexed { i, cause ->
    val color = BranchColors[i % BranchColors.size]
    InfoCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
      Tag("Causa", color)
      Text(
        cause.label,
        color = color,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 4.dp),
      )
      cause.detail?.let {
        Text(
          it,
          color = TextSecondary,
          fontSize = 12.5.sp,
          lineHeight = 17.sp,
          modifier = Modifier.padding(top = 4.dp),
        )
      }
      Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("↓", color = color, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(6.dp))
        Text(
          "EFECTOS",
          color = color,
          fontSize = 10.sp,
          fontWeight = FontWeight.Bold,
          letterSpacing = 1.sp,
        )
      }
      Bullets(cause.effects, color)
    }
  }
}

@Composable
private fun SolutionView(data: MindData) {
  OverallHeader(data.title, "${data.problems.size} problemas")
  data.problems.forEachIndexed { i, problem ->
    val color = BranchColors[i % BranchColors.size]
    InfoCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
      Tag("Problema", color)
      Text(
        problem.label,
        color = color,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 4.dp),
      )
      problem.detail?.let {
        Text(
          it,
          color = TextSecondary,
          fontSize = 12.5.sp,
          lineHeight = 17.sp,
          modifier = Modifier.padding(top = 4.dp),
        )
      }
      HorizontalDivider(Modifier.padding(vertical = 8.dp), color = BorderCol)
      Tag("Solución", GreenOk)
      Bullets(problem.solutions, GreenOk)
    }
  }
}
