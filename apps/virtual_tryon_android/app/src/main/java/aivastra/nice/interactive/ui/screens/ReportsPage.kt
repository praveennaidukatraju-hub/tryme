package tryme.nice.interactive.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import tryme.nice.interactive.R
import tryme.nice.interactive.data.models.TryOnHistoryDay
import tryme.nice.interactive.data.repository.TryOnHistoryRepository
import tryme.nice.interactive.data.repository.TryOnHistoryResult
import tryme.nice.interactive.ui.components.AppHeaderLogo
import tryme.nice.interactive.ui.components.AppLoadingIndicator
import tryme.nice.interactive.ui.theme.TryMeTheme
import tryme.nice.interactive.ui.theme.ButtonGradient
import tryme.nice.interactive.ui.theme.PoppinsFamily
import tryme.nice.interactive.utils.sdp
import tryme.nice.interactive.utils.ssp
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * Merchant "Reports" screen — a per-day summary of customer photo uploads vs.
 * completed/failed try-on generations, backed by GET /v1/merchant/tryon/history.
 * Reached from the 3-dot menu on Category Selection.
 */
@Composable
fun ReportsPage(
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    BackHandler(onBack = onBack)

    val repository = remember { TryOnHistoryRepository() }
    val scope = rememberCoroutineScope()

    var days by remember { mutableStateOf<List<TryOnHistoryDay>>(emptyList()) }
    var nextCursor by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var isLoadingMore by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var loadMoreError by remember { mutableStateOf<String?>(null) }
    var hasLoadedOnce by remember { mutableStateOf(false) }

    fun loadPage(before: String?, append: Boolean) {
        if (append) {
            if (isLoadingMore || isLoading) return
            isLoadingMore = true
            loadMoreError = null
        } else {
            isLoading = true
            errorMessage = null
        }
        scope.launch {
            when (val result = repository.getHistory(before = before, limit = 30)) {
                is TryOnHistoryResult.Success -> {
                    days = if (append) days + result.data.days else result.data.days
                    nextCursor = result.data.nextCursor
                    hasLoadedOnce = true
                }
                is TryOnHistoryResult.Failure -> {
                    if (append) loadMoreError = result.message else errorMessage = result.message
                }
            }
            isLoading = false
            isLoadingMore = false
        }
    }

    LaunchedEffect(Unit) { loadPage(before = null, append = false) }

    val listState = rememberLazyListState()
    val shouldLoadMore by remember {
        derivedStateOf {
            val layoutInfo = listState.layoutInfo
            val total = layoutInfo.totalItemsCount
            val lastVisible = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            total > 0 && lastVisible >= total - 3
        }
    }
    LaunchedEffect(shouldLoadMore, nextCursor, loadMoreError) {
        if (shouldLoadMore && nextCursor != null && loadMoreError == null) {
            loadPage(before = nextCursor, append = true)
        }
    }

    val isPreview = LocalInspectionMode.current
    val statusBarH: Dp = (if (isPreview) sdp(R.dimen._28sdp) else WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) + sdp(R.dimen._10sdp)
    val navBarH: Dp = if (isPreview) 14.dp else WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        Image(
            painter = painterResource(id = R.drawable.new_app_bg),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = sdp(R.dimen._20sdp)),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = sdp(R.dimen._screen_container_width))
                    .fillMaxWidth()
                    .weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(Modifier.height(statusBarH))

                // ── Top Bar (Back Arrow + Logo Header) ──────────────────────
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = sdp(R.dimen._10sdp))
                ) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .size(sdp(R.dimen._38sdp))
                            .clip(CircleShape)
                            .background(
                                Brush.linearGradient(
                                    listOf(Color(0xFFE7A52C), Color(0xFF9B5100))
                                )
                            )
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = onBack
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = Color.White,
                            modifier = Modifier.size(sdp(R.dimen._20sdp))
                        )
                    }

                    AppHeaderLogo(modifier = Modifier.align(Alignment.Center))
                }

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                // ── Page Title ────────────────────────────────────────────
                Text(
                    text = buildAnnotatedString {
                        withStyle(SpanStyle(color = Color.White)) { append("Try-On ") }
                        withStyle(SpanStyle(brush = ButtonGradient)) { append("Reports") }
                    },
                    fontSize = ssp(R.dimen._22ssp),
                    fontWeight = FontWeight.Bold,
                    fontFamily = PoppinsFamily
                )
                Spacer(Modifier.height(sdp(R.dimen._4sdp)))
                Text(
                    text = "Daily photo uploads & generated try-ons",
                    color = Color.White.copy(alpha = 0.55f),
                    fontSize = ssp(R.dimen._12ssp),
                    fontFamily = PoppinsFamily,
                    fontWeight = FontWeight.Normal
                )

                Spacer(Modifier.height(sdp(R.dimen._20sdp)))

                Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
                    when {
                        isLoading && !hasLoadedOnce -> Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            AppLoadingIndicator(size = sdp(R.dimen._32sdp))
                        }

                        errorMessage != null && !hasLoadedOnce -> ReportsMessage(
                            message = errorMessage.orEmpty(),
                            actionLabel = "Retry",
                            onAction = { loadPage(before = null, append = false) }
                        )

                        days.isEmpty() -> ReportsMessage(
                            message = "No try-on activity yet. Once customers upload photos and generate try-ons, daily stats will show up here.",
                            actionLabel = "Refresh",
                            onAction = { loadPage(before = null, append = false) }
                        )

                        else -> LazyColumn(
                            state = listState,
                            verticalArrangement = Arrangement.spacedBy(sdp(R.dimen._12sdp)),
                            contentPadding = PaddingValues(bottom = sdp(R.dimen._16sdp)),
                            modifier = Modifier.fillMaxSize()
                        ) {
                            items(days, key = { it.date }) { day ->
                                ReportDayCard(day)
                            }
                            item(key = "footer") {
                                ReportsFooter(
                                    isLoadingMore = isLoadingMore,
                                    hasMore = nextCursor != null,
                                    loadMoreError = loadMoreError,
                                    onRetry = { loadPage(before = nextCursor, append = true) }
                                )
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(navBarH))
        }
    }
}

// ─── Day summary card ──────────────────────────────────────────────────────

@Composable
private fun ReportDayCard(day: TryOnHistoryDay, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(sdp(R.dimen._14sdp)))
            .background(Color.White.copy(alpha = 0.06f))
            .border(sdp(R.dimen._1sdp), Color.White.copy(alpha = 0.10f), RoundedCornerShape(sdp(R.dimen._14sdp)))
            .padding(sdp(R.dimen._14sdp))
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Icons.Default.DateRange,
                contentDescription = null,
                tint = Color(0xFFD88A18),
                modifier = Modifier.size(sdp(R.dimen._14sdp))
            )
            Spacer(Modifier.width(sdp(R.dimen._6sdp)))
            Text(
                text = formatReportDate(day.date),
                color = Color.White,
                fontSize = ssp(R.dimen._14ssp),
                fontWeight = FontWeight.SemiBold,
                fontFamily = PoppinsFamily
            )
        }

        Spacer(Modifier.height(sdp(R.dimen._12sdp)))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            ReportStat(
                label = "Photos",
                value = day.inputCount,
                valueColor = Color.White,
                modifier = Modifier.weight(1f)
            )
            ReportStat(
                label = "Generated",
                value = day.generatedCount,
                valueColor = Color(0xFFE7A52C),
                modifier = Modifier.weight(1f)
            )
            ReportStat(
                label = "Failed",
                value = day.failedCount,
                valueColor = if (day.failedCount > 0) Color(0xFFE05252) else Color.White.copy(alpha = 0.35f),
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@Composable
private fun ReportStat(
    label: String,
    value: Int,
    valueColor: Color,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = value.toString(),
            color = valueColor,
            fontSize = ssp(R.dimen._18ssp),
            fontWeight = FontWeight.Bold,
            fontFamily = PoppinsFamily
        )
        Spacer(Modifier.height(sdp(R.dimen._2sdp)))
        Text(
            text = label,
            color = Color.White.copy(alpha = 0.5f),
            fontSize = ssp(R.dimen._10ssp),
            fontFamily = PoppinsFamily,
            fontWeight = FontWeight.Medium
        )
    }
}

// ─── List footer: pagination spinner / retry / end-of-list ─────────────────

@Composable
private fun ReportsFooter(
    isLoadingMore: Boolean,
    hasMore: Boolean,
    loadMoreError: String?,
    onRetry: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = sdp(R.dimen._14sdp)),
        contentAlignment = Alignment.Center
    ) {
        when {
            isLoadingMore -> AppLoadingIndicator(size = sdp(R.dimen._20sdp))
            loadMoreError != null -> Text(
                text = "Couldn't load more. Tap to retry.",
                color = Color(0xFFE05252),
                fontSize = ssp(R.dimen._11ssp),
                fontFamily = PoppinsFamily,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .clip(RoundedCornerShape(sdp(R.dimen._50sdp)))
                    .clickable(onClick = onRetry)
                    .padding(horizontal = sdp(R.dimen._16sdp), vertical = sdp(R.dimen._8sdp))
            )
            !hasMore -> Text(
                text = "That's all for now",
                color = Color.White.copy(alpha = 0.35f),
                fontSize = ssp(R.dimen._11ssp),
                fontFamily = PoppinsFamily
            )
        }
    }
}

// ─── Full-screen message (error / empty) ────────────────────────────────────

@Composable
private fun ReportsMessage(
    message: String,
    actionLabel: String? = null,
    onAction: () -> Unit = {}
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(sdp(R.dimen._32sdp)),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.List,
            contentDescription = null,
            tint = Color.White.copy(alpha = 0.3f),
            modifier = Modifier.size(sdp(R.dimen._32sdp))
        )
        Spacer(Modifier.height(sdp(R.dimen._12sdp)))
        Text(
            text = message,
            color = Color.White.copy(alpha = 0.7f),
            fontSize = ssp(R.dimen._12ssp),
            fontFamily = PoppinsFamily,
            textAlign = TextAlign.Center
        )
        if (actionLabel != null) {
            Spacer(Modifier.height(sdp(R.dimen._12sdp)))
            Text(
                text = actionLabel,
                color = Color(0xFFE59B17),
                fontWeight = FontWeight.SemiBold,
                fontFamily = PoppinsFamily,
                modifier = Modifier
                    .clip(RoundedCornerShape(sdp(R.dimen._50sdp)))
                    .border(
                        sdp(R.dimen._1sdp),
                        Color(0xFFE59B17),
                        RoundedCornerShape(sdp(R.dimen._50sdp))
                    )
                    .clickable(onClick = onAction)
                    .padding(horizontal = sdp(R.dimen._20sdp), vertical = sdp(R.dimen._8sdp))
            )
        }
    }
}

// ─── Date formatting ─────────────────────────────────────────────────────────

private val reportDateFormatterSameYear = DateTimeFormatter.ofPattern("EEE, MMM d")
private val reportDateFormatterOtherYear = DateTimeFormatter.ofPattern("MMM d, yyyy")

/** Formats a "yyyy-MM-dd" API date into "Today" / "Yesterday" / "Thu, Aug 20" / "Aug 20, 2025". */
private fun formatReportDate(isoDate: String): String {
    val date = try {
        LocalDate.parse(isoDate)
    } catch (e: DateTimeParseException) {
        return isoDate
    }
    val today = LocalDate.now()
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> if (date.year == today.year) {
            date.format(reportDateFormatterSameYear)
        } else {
            date.format(reportDateFormatterOtherYear)
        }
    }
}

@Preview(showBackground = true, widthDp = 420, heightDp = 780)
@Composable
private fun ReportsPagePreview() {
    TryMeTheme { ReportsPage(onBack = {}) }
}
