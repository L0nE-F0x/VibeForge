package net.vibeforge.widget

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

data class WidgetSession(
    val ptyId: String,
    val runId: String,
    val title: String,
    val detail: String,
    val workspace: String,
    val state: String, // "waiting" | "working" | "done"
    val startedAt: String,
    val endedAt: String,
    val agoText: String,
    val changes: String,
    val alsoHere: List<String>,
)

data class WidgetPlan(
    val id: String,
    val name: String,
    val percent: Int?,
    val limiter: String,
    val resetText: String,
    val fullInText: String,
    val secondaryText: String,
    val credits: Double?,
    val problem: String?,
)

data class WidgetViby(
    val thinking: Boolean,
    val activityLabel: String,
    val waitingTurnId: String,
    val waitingSummary: String,
    val waitingStepCount: Int,
    /** Steps of the waiting plan that can't run as they are: Go skips them, as on the phone page. */
    val blockedStepCount: Int,
    val runningTurn: Boolean,
    val copiesCount: Int,
) {
    val hasBanner: Boolean
        get() = thinking || runningTurn || waitingTurnId.isNotEmpty() || copiesCount > 0

    /** The phone page's Go is off only when no step of the plan could run. */
    val canGo: Boolean
        get() = waitingTurnId.isNotEmpty() && waitingStepCount > 0 && blockedStepCount < waitingStepCount
}

data class WidgetDashboard(
    val sessions: List<WidgetSession>,
    val recentDone: List<WidgetSession>,
    val waitingCount: Int,
    val workingCount: Int,
    val nudges: List<String>,
    val plans: List<WidgetPlan>,
    val viby: WidgetViby?,
    val updatedAtMs: Long,
    val error: String? = null,
)

data class SessionPeek(
    val ptyId: String,
    val runId: String,
    val title: String,
    val state: String,
    val screen: String,
    val canSend: Boolean,
)

class ApiHttpException(
    val status: Int,
    val working: Boolean,
    message: String,
) : IllegalStateException(message)

/** What a computer gave the widget for its pairing code: the key to keep, and what it calls itself. */
data class Pairing(val key: String, val computer: String)

sealed class FetchResult {
    data object NotModified : FetchResult()
    data class Fresh(val body: String, val etag: String?) : FetchResult()
}

object VibeForgeApi {
    val networkExecutor = Executors.newCachedThreadPool()
    private val fetchExecutor = Executors.newCachedThreadPool()

    private val DEFAULT_NUDGES = listOf(
        "Keep going.",
        "Commit what you have and tell me what changed.",
        "Stop and summarize where things stand.",
    )

    private val PLAN_NAMES = mapOf(
        "claude" to "Claude",
        "codex" to "Codex",
        "grok" to "Grok",
        "agy" to "Gemini",
        "kimi" to "Kimi",
        "muse" to "Muse",
    )

    /** Who the widget is, so Settings → Phone lists it as "VibeForge widget (<phone>)", apart from the phone's browser. */
    val userAgent: String by lazy {
        val model = Build.MODEL.orEmpty().replace(Regex("[;()\\r\\n]"), " ").trim().take(30)
        val release = Build.VERSION.RELEASE.orEmpty().replace(Regex("[;()\\r\\n]"), " ").trim()
        "VibeForgeWidget/${BuildConfig.VERSION_NAME} (Android $release${if (model.isNotEmpty()) "; $model" else ""})"
    }

    private const val NOT_SET_UP = "Tap ⚙ to add your computer: scan the QR code in its Settings → Phone."

    private fun notPaired(machine: Machine) =
        "Not paired with ${machine.name}. Tap ⚙ and scan the QR code in its Settings → Phone."

    /** What the widget says once a computer stops taking its key. */
    fun keyRejectedText(name: String) =
        "$name no longer takes this widget's key: it was removed in Settings → Phone, or the key is no longer valid. Tap ⚙ to pair again."

    /**
     * A computer refused the widget's key (401): let it go, so the widget asks to pair again instead
     * of asking with it every few seconds. Every request's 401 comes here.
     */
    fun keyRejected(context: Context, machine: Machine) {
        val appContext = context.applicationContext
        VibeForgeStore.forgetKey(appContext, machine.id)
        VibeForgeStore.saveError(appContext, machine.id, keyRejectedText(machine.name))
    }

    fun refreshNow(context: Context, timeoutMs: Int = 4_500): WidgetDashboard {
        val appContext = context.applicationContext
        val machine = VibeForgeStore.getActive(appContext)
        if (machine == null || machine.url.isBlank()) {
            VibeForgeStore.saveError(appContext, null, NOT_SET_UP)
            return VibeForgeStore.getCachedDashboard(appContext)
        }
        refreshMachine(appContext, machine, timeoutMs)
        return VibeForgeStore.getCachedDashboard(appContext)
    }

    fun refreshMachine(context: Context, machine: Machine, timeoutMs: Int = 8_000): Boolean {
        val appContext = context.applicationContext
        if (machine.url.isBlank()) {
            VibeForgeStore.saveError(appContext, machine.id, NOT_SET_UP)
            return false
        }
        if (!machine.paired) {
            // A key it was told no longer works keeps that sentence: it says why.
            val said = VibeForgeStore.getCachedDashboardFor(appContext, machine.id).error
            if (said == null || said != keyRejectedText(machine.name)) VibeForgeStore.saveError(appContext, machine.id, notPaired(machine))
            return false
        }
        val deskEtag = VibeForgeStore.getEtag(appContext, machine.id, "desk")
        val plansEtag = VibeForgeStore.getEtag(appContext, machine.id, "plans")
        val orchEtag = VibeForgeStore.getEtag(appContext, machine.id, "orch")

        val plansFuture = fetchExecutor.submit(Callable<FetchResult?> {
            try {
                fetchWithEtag(machine.url, "/api/plans", machine.key, plansEtag, timeoutMs)
            } catch (_: Exception) {
                null
            }
        })
        val orchFuture = fetchExecutor.submit(Callable<FetchResult?> {
            try {
                fetchWithEtag(machine.url, "/api/orchestrator", machine.key, orchEtag, timeoutMs)
            } catch (_: Exception) {
                null
            }
        })

        return try {
            val deskResult = fetchWithEtag(machine.url, "/api/desk", machine.key, deskEtag, timeoutMs)
            val plansResult = try {
                plansFuture.get()
            } catch (_: Exception) {
                null
            }
            val orchResult = try {
                orchFuture.get()
            } catch (_: Exception) {
                null
            }

            if (deskResult is FetchResult.Fresh) {
                val computer = try {
                    JSONObject(deskResult.body).optString("computer").trim()
                } catch (_: Exception) {
                    ""
                }
                if (computer.isNotEmpty()) {
                    VibeForgeStore.maybeUpdateComputerName(appContext, machine.id, computer)
                }
            }

            VibeForgeStore.saveSnapshot(
                context = appContext,
                machineId = machine.id,
                deskJson = (deskResult as? FetchResult.Fresh)?.body,
                plansJson = (plansResult as? FetchResult.Fresh)?.body,
                orchJson = (orchResult as? FetchResult.Fresh)?.body,
                deskEtag = (deskResult as? FetchResult.Fresh)?.etag,
                plansEtag = (plansResult as? FetchResult.Fresh)?.etag,
                orchEtag = (orchResult as? FetchResult.Fresh)?.etag,
            )
            true
        } catch (e: ApiHttpException) {
            plansFuture.cancel(true)
            orchFuture.cancel(true)
            if (e.status == 401) keyRejected(appContext, machine) else VibeForgeStore.saveError(appContext, machine.id, e.message ?: "HTTP ${e.status}")
            false
        } catch (e: Exception) {
            plansFuture.cancel(true)
            orchFuture.cancel(true)
            VibeForgeStore.saveError(appContext, machine.id, "Can't reach ${machine.name} — is it on, and is Tailscale connected?")
            false
        }
    }

    /**
     * Pairs with a computer: its pairing code, sent once, for a key of this widget's own. The code is
     * not kept. A computer from before 3.6.3 hands out no keys; with one of those the code stays the
     * key, as the phone page does.
     */
    fun pair(baseUrl: String, code: String, timeoutMs: Int = 10_000): Pairing {
        val answer = try {
            postJson(baseUrl, "/api/pair", "", JSONObject().put("token", code), timeoutMs)
        } catch (e: ApiHttpException) {
            throw when (e.status) {
                401 -> ApiHttpException(401, false, "That pairing code isn't this computer's. Copy it again from Settings → Phone (a new code replaces the old one).")
                429 -> ApiHttpException(429, false, "Too many wrong codes. Wait a minute, then try again.")
                else -> e
            }
        }
        val key = answer.optString("key")
        return Pairing(
            key = if (KEY_REGEX.matches(key)) key else code,
            computer = answer.optString("computer").trim(),
        )
    }

    private val KEY_REGEX = Regex("^vfd_[0-9a-f]{48}$")

    /**
     * A place on the computer's phone page (companion/js/pages.js, followLink): it opens at what was
     * tapped. A session; one of Viby's plans; Viby; or the desk.
     */
    fun sessionLink(baseUrl: String, s: WidgetSession): String =
        "${baseUrl.trimEnd('/')}/?ptyId=${Uri.encode(s.ptyId)}&runId=${Uri.encode(s.runId)}"

    fun planLink(baseUrl: String, turnId: String): String =
        "${baseUrl.trimEnd('/')}/?view=maestro&turn=${Uri.encode(turnId)}"

    fun vibyLink(baseUrl: String, viby: WidgetViby?): String =
        if (viby != null && viby.waitingTurnId.isNotEmpty()) planLink(baseUrl, viby.waitingTurnId) else "${baseUrl.trimEnd('/')}/?view=maestro"

    fun deskLink(baseUrl: String): String = "${baseUrl.trimEnd('/')}/?view=desk"

    fun fetchWithEtag(
        baseUrl: String,
        path: String,
        token: String,
        ifNoneMatch: String? = null,
        timeoutMs: Int = 8_000,
    ): FetchResult {
        val endpoint = URL("${baseUrl.trimEnd('/')}$path")
        val conn = (endpoint.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", userAgent)
            if (token.isNotEmpty()) {
                setRequestProperty("Authorization", "Bearer $token")
            }
            if (!ifNoneMatch.isNullOrBlank()) {
                setRequestProperty("If-None-Match", ifNoneMatch)
            }
        }
        try {
            val status = conn.responseCode
            if (status == HttpURLConnection.HTTP_NOT_MODIFIED) {
                return FetchResult.NotModified
            }
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { reader -> reader.readText() }
            }.orEmpty()
            if (status == 401) {
                throw ApiHttpException(401, false, "This widget's key was refused: it was removed in Settings → Phone, or is no longer valid. Tap ⚙ to pair again.")
            }
            if (status !in 200..299) {
                val parsed = try {
                    JSONObject(body)
                } catch (_: Exception) {
                    null
                }
                val msg = parsed?.optString("error")?.takeIf { it.isNotEmpty() }
                val working = parsed?.optBoolean("working", false) == true
                throw ApiHttpException(status, working, msg ?: "HTTP $status from VibeForge")
            }
            return FetchResult.Fresh(body, conn.getHeaderField("ETag"))
        } finally {
            conn.disconnect()
        }
    }

    fun fetchJson(baseUrl: String, path: String, token: String, timeoutMs: Int = 8_000): String {
        return when (val result = fetchWithEtag(baseUrl, path, token, null, timeoutMs)) {
            is FetchResult.Fresh -> result.body
            FetchResult.NotModified -> ""
        }
    }

    fun postJson(
        baseUrl: String,
        path: String,
        token: String,
        payload: JSONObject,
        timeoutMs: Int = 10_000,
    ): JSONObject {
        val endpoint = URL("${baseUrl.trimEnd('/')}$path")
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        val conn = (endpoint.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            doOutput = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("User-Agent", userAgent)
            if (token.isNotEmpty()) {
                setRequestProperty("Authorization", "Bearer $token")
            }
            setFixedLengthStreamingMode(bytes.size)
        }
        try {
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { reader -> reader.readText() }
            }.orEmpty()
            if (status == 401) {
                throw ApiHttpException(401, false, "This widget's key was refused: it was removed in Settings → Phone, or is no longer valid. Tap ⚙ to pair again.")
            }
            if (status !in 200..299) {
                val parsed = try {
                    JSONObject(body)
                } catch (_: Exception) {
                    null
                }
                val msg = parsed?.optString("error")?.takeIf { it.isNotEmpty() }
                val working = parsed?.optBoolean("working", false) == true
                throw ApiHttpException(status, working, msg ?: "HTTP $status from VibeForge")
            }
            return if (body.isBlank()) JSONObject() else JSONObject(body)
        } finally {
            conn.disconnect()
        }
    }

    fun fetchSessionPeek(
        baseUrl: String,
        token: String,
        ptyId: String,
        runId: String,
        timeoutMs: Int = 8_000,
    ): SessionPeek {
        val query = "/api/session?ptyId=${java.net.URLEncoder.encode(ptyId, "UTF-8")}&runId=${java.net.URLEncoder.encode(runId, "UTF-8")}"
        val root = JSONObject(fetchJson(baseUrl, query, token, timeoutMs))
        return SessionPeek(
            ptyId = if (root.isNull("ptyId")) "" else root.optString("ptyId"),
            runId = if (root.isNull("runId")) "" else root.optString("runId"),
            title = root.optString("title", "Session"),
            state = root.optString("state", "waiting"),
            screen = root.optString("screen", ""),
            canSend = root.optBoolean("canSend", false),
        )
    }

    fun tailScreenLines(screen: String, maxLines: Int = 8): String {
        val cleaned = screen.replace("\r\n", "\n").replace("\r", "").trimEnd()
        if (cleaned.isEmpty()) return "Nothing on screen yet."
        val lines = cleaned.split("\n")
        return lines.takeLast(maxLines).joinToString("\n").trim()
    }

    fun parseDashboard(
        deskJsonStr: String?,
        plansJsonStr: String?,
        orchJsonStr: String? = null,
        updatedAtMs: Long,
        error: String?,
    ): WidgetDashboard {
        val nowMs = System.currentTimeMillis()
        val sessions = mutableListOf<WidgetSession>()
        val doneSessions = mutableListOf<WidgetSession>()
        var nudges = DEFAULT_NUDGES

        if (!deskJsonStr.isNullOrBlank()) {
            try {
                val root = JSONObject(deskJsonStr)
                val nudgesArr = root.optJSONArray("nudges")
                if (nudgesArr != null && nudgesArr.length() > 0) {
                    val parsedNudges = mutableListOf<String>()
                    for (i in 0 until nudgesArr.length()) {
                        val n = nudgesArr.optString(i).trim()
                        if (n.isNotEmpty()) parsedNudges.add(n)
                    }
                    if (parsedNudges.isNotEmpty()) nudges = parsedNudges
                }
                val workspaces = root.optJSONArray("workspaces")
                if (workspaces != null) {
                    for (i in 0 until workspaces.length()) {
                        val ws = workspaces.optJSONObject(i) ?: continue
                        val wsId = ws.optString("id")
                        val wsName = if (wsId.isNotEmpty()) ws.optString("name", "Workspace") else "Elsewhere"
                        val wsSessions = ws.optJSONArray("sessions") ?: continue
                        for (j in 0 until wsSessions.length()) {
                            val s = wsSessions.optJSONObject(j) ?: continue
                            val state = s.optString("state")
                            if (state != "waiting" && state != "working" && state != "done") continue
                            val startedAt = s.optString("startedAt")
                            val endedAt = if (s.isNull("endedAt")) "" else s.optString("endedAt")
                            val changes = if (s.isNull("changes")) "" else s.optString("changes")
                            val alsoArr = s.optJSONArray("alsoHere")
                            val alsoList = mutableListOf<String>()
                            if (alsoArr != null) {
                                for (k in 0 until alsoArr.length()) {
                                    val other = alsoArr.optString(k).trim()
                                    if (other.isNotEmpty()) alsoList.add(other)
                                }
                            }
                            val item = WidgetSession(
                                ptyId = if (s.isNull("ptyId")) "" else s.optString("ptyId"),
                                runId = if (s.isNull("runId")) "" else s.optString("runId"),
                                title = s.optString("title", "Session"),
                                detail = s.optString("detail", ""),
                                workspace = wsName,
                                state = state,
                                startedAt = startedAt,
                                endedAt = endedAt,
                                agoText = formatAgo(if (state == "done" && endedAt.isNotEmpty()) endedAt else startedAt, nowMs),
                                changes = changes,
                                alsoHere = alsoList,
                            )
                            if (state == "done") doneSessions.add(item) else sessions.add(item)
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }

        // Sort: "waiting" first (needs human input), then "working", newest first within each state
        sessions.sortWith(
            Comparator { a, b ->
                if (a.state != b.state) {
                    if (a.state == "waiting") -1 else 1
                } else {
                    b.startedAt.compareTo(a.startedAt)
                }
            }
        )
        doneSessions.sortByDescending { it.endedAt.ifEmpty { it.startedAt } }
        val recentDone = doneSessions.take(3)

        val waitingCount = sessions.count { it.state == "waiting" }
        val workingCount = sessions.count { it.state == "working" }

        val plans = mutableListOf<WidgetPlan>()
        if (!plansJsonStr.isNullOrBlank()) {
            try {
                val root = JSONObject(plansJsonStr)
                val plansObj = root.optJSONObject("plans") ?: root
                val providers = plansObj.optJSONArray("providers")
                if (providers != null) {
                    for (i in 0 until providers.length()) {
                        val p = providers.optJSONObject(i) ?: continue
                        val id = p.optString("id")
                        val name = PLAN_NAMES[id] ?: id.replaceFirstChar { it.uppercase() }
                        val pct = if (p.isNull("percent")) null else p.optDouble("percent").roundToInt()
                        val limiter = if (p.isNull("limiter")) "" else p.optString("limiter")
                        val resetsAt = if (p.isNull("resetsAt")) "" else p.optString("resetsAt")
                        val fullAt = if (p.isNull("fullAt")) "" else p.optString("fullAt")
                        val credits = if (p.isNull("credits")) null else p.optDouble("credits").takeIf { !it.isNaN() && it > 0 }
                        val problem = if (p.isNull("problem")) null else p.optString("problem")
                        val windowsArr = p.optJSONArray("windows")
                        var secondary = ""
                        if (windowsArr != null && windowsArr.length() > 1) {
                            for (wIdx in 0 until windowsArr.length()) {
                                val w = windowsArr.optJSONObject(wIdx) ?: continue
                                val wName = w.optString("name")
                                if (wName.isNotEmpty() && wName != limiter) {
                                    val wPct = w.optDouble("percent").roundToInt()
                                    secondary = "${shortWindowName(wName)} $wPct%"
                                    break
                                }
                            }
                        }
                        val fullInText = parseIsoMs(fullAt)?.let { ts ->
                            if (ts - nowMs in 1..(48 * 3600_000L)) formatSpanUntil(fullAt, nowMs) else ""
                        }.orEmpty()
                        plans.add(
                            WidgetPlan(
                                id = id,
                                name = name,
                                percent = pct,
                                limiter = limiter,
                                resetText = formatSpanUntil(resetsAt, nowMs),
                                fullInText = fullInText,
                                secondaryText = secondary,
                                credits = credits,
                                problem = problem,
                            )
                        )
                    }
                }
            } catch (_: Exception) {
            }
        }

        val viby = parseViby(orchJsonStr)

        return WidgetDashboard(
            sessions = sessions,
            recentDone = recentDone,
            waitingCount = waitingCount,
            workingCount = workingCount,
            nudges = nudges,
            plans = plans,
            viby = viby,
            updatedAtMs = updatedAtMs,
            error = error,
        )
    }

    private fun parseViby(orchJsonStr: String?): WidgetViby? {
        if (orchJsonStr.isNullOrBlank()) return null
        return try {
            val root = JSONObject(orchJsonStr)
            val thinking = root.optBoolean("thinking", false)
            val activityObj = root.optJSONObject("activity")
            val activityLabel = activityObj?.optString("label").orEmpty().trim()
            val copiesCount = root.optJSONArray("copies")?.length() ?: 0
            val turns = root.optJSONArray("turns")
            var waitingTurnId = ""
            var waitingSummary = ""
            var waitingStepCount = 0
            var blockedStepCount = 0
            var runningTurn = false

            if (turns != null) {
                for (i in turns.length() - 1 downTo 0) {
                    val turn = turns.optJSONObject(i) ?: continue
                    val plan = if (turn.isNull("plan")) "" else turn.optString("plan")
                    if (plan == "running") runningTurn = true
                    if (plan == "waiting" && waitingTurnId.isEmpty()) {
                        waitingTurnId = turn.optString("id")
                        val steps = turn.optJSONArray("steps")
                        waitingStepCount = steps?.length() ?: 0
                        if (steps != null) {
                            for (sIdx in 0 until steps.length()) {
                                val step = steps.optJSONObject(sIdx) ?: continue
                                if (!step.isNull("issue") && step.optString("issue").isNotEmpty()) blockedStepCount += 1
                            }
                        }
                        val said = turn.optString("text", "").replace("\n", " ").trim()
                        waitingSummary = if (said.isNotEmpty()) {
                            said.take(64)
                        } else {
                            val noun = if (waitingStepCount == 1) "step" else "steps"
                            "$waitingStepCount $noun waiting for Go"
                        }
                    }
                }
            }

            WidgetViby(
                thinking = thinking,
                activityLabel = when {
                    activityLabel.isNotEmpty() -> activityLabel
                    thinking -> "Viby is thinking…"
                    runningTurn -> "Viby carrying out plan…"
                    else -> ""
                },
                waitingTurnId = waitingTurnId,
                waitingSummary = waitingSummary,
                waitingStepCount = waitingStepCount,
                blockedStepCount = blockedStepCount,
                runningTurn = runningTurn,
                copiesCount = copiesCount,
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun shortWindowName(name: String): String {
        val lower = name.lowercase(Locale.ROOT)
        return when {
            "5-hour" in lower || "5h" in lower -> "5h"
            "7-day" in lower || "week" in lower -> "wk"
            "month" in lower -> "mo"
            else -> name.take(6)
        }
    }

    fun statusBadge(data: WidgetDashboard): Triple<String, Int, Int> {
        val vibyWaiting = data.viby?.waitingTurnId?.isNotEmpty() == true
        val vibyWorking = data.viby?.thinking == true || data.viby?.runningTurn == true
        val copies = data.viby?.copiesCount ?: 0
        return when {
            data.waitingCount > 0 && data.workingCount > 0 ->
                Triple("${data.waitingCount} WAIT · ${data.workingCount} WORK", Color.parseColor("#FCA311"), R.drawable.bg_pill_waiting)
            data.waitingCount > 0 ->
                Triple("${data.waitingCount} WAITING", Color.parseColor("#FCA311"), R.drawable.bg_pill_waiting)
            vibyWaiting ->
                Triple("VIBY · GO", Color.parseColor("#FCA311"), R.drawable.bg_pill_waiting)
            data.workingCount > 0 ->
                Triple("${data.workingCount} WORKING", Color.parseColor("#FF6B35"), R.drawable.bg_pill_working)
            vibyWorking ->
                Triple("VIBY WORK", Color.parseColor("#FF6B35"), R.drawable.bg_pill_working)
            copies > 0 ->
                Triple("$copies REVIEW", Color.parseColor("#E4E4E7"), R.drawable.bg_pill_quiet)
            else ->
                Triple("QUIET", Color.parseColor("#A1A1AA"), R.drawable.bg_pill_quiet)
        }
    }

    fun sessionSubtitle(s: WidgetSession): String {
        val parts = mutableListOf<String>()
        if (s.workspace.isNotEmpty() && !s.title.contains(s.workspace)) {
            parts.add(s.workspace)
        }
        if (s.detail.isNotEmpty() && s.detail != s.title) {
            parts.add(s.detail)
        }
        if (s.changes.isNotEmpty()) {
            parts.add(s.changes)
        }
        if (s.alsoHere.isNotEmpty()) {
            parts.add("+${s.alsoHere.joinToString(", ")}")
        }
        if (s.agoText.isNotEmpty()) {
            parts.add(s.agoText)
        }
        return if (parts.isNotEmpty()) parts.joinToString(" · ") else s.workspace
    }

    fun recentBarSession(data: WidgetDashboard): WidgetSession? {
        val recent = data.recentDone.firstOrNull() ?: return null
        val stamp = parseIsoMs(recent.endedAt.ifEmpty { recent.startedAt }) ?: return null
        return if (System.currentTimeMillis() - stamp < 2 * 3600_000L) recent else null
    }

    fun barSessionSummary(data: WidgetDashboard): Pair<String, Int> {
        if (!data.error.isNullOrBlank() && data.sessions.isEmpty()) {
            return data.error to Color.parseColor("#FF4D6D")
        }
        val lead = data.sessions.firstOrNull()
        if (lead != null) {
            val base = if (lead.workspace.isNotEmpty() && !lead.title.contains(lead.workspace)) {
                "${lead.title} · ${lead.workspace}"
            } else {
                lead.title
            }
            val extra = if (data.sessions.size > 1) " (+${data.sessions.size - 1})" else ""
            val color = if (lead.state == "waiting") Color.parseColor("#FCA311") else Color.parseColor("#FF6B35")
            val prefix = if (lead.state == "waiting") "● " else "▸ "
            return "$prefix$base$extra" to color
        }
        val viby = data.viby
        if (viby != null) {
            if (viby.waitingTurnId.isNotEmpty()) {
                return "● Viby: ${viby.waitingSummary}" to Color.parseColor("#FCA311")
            }
            if (viby.thinking || viby.runningTurn) {
                return "▸ ${viby.activityLabel.ifEmpty { "Viby working…" }}" to Color.parseColor("#FF6B35")
            }
            if (viby.copiesCount > 0) {
                val noun = if (viby.copiesCount == 1) "copy" else "copies"
                return "${viby.copiesCount} Viby $noun to review" to Color.parseColor("#E4E4E7")
            }
        }
        if (!data.error.isNullOrBlank()) {
            return data.error to Color.parseColor("#FF4D6D")
        }
        val recent = recentBarSession(data)
        if (recent != null) {
            val base = if (recent.workspace.isNotEmpty() && !recent.title.contains(recent.workspace)) {
                "${recent.title} · ${recent.workspace}"
            } else {
                recent.title
            }
            val ago = if (recent.agoText.isNotEmpty()) " (${recent.agoText})" else ""
            return "✓ $base$ago" to Color.parseColor("#A1A1AA")
        }
        return "No active sessions · Quiet" to Color.parseColor("#71717A")
    }

    fun barMetaSummary(data: WidgetDashboard, syncing: Boolean): Pair<String, Int> {
        val busiest = data.plans.filter { it.percent != null }.maxByOrNull { it.percent ?: -1 }
        val planPart = busiest?.let { "${it.name} ${it.percent}%" }
        val timePart = when {
            syncing -> "syncing…"
            data.updatedAtMs > 0L -> SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(data.updatedAtMs))
            else -> ""
        }
        val text = listOfNotNull(planPart, timePart.takeIf { it.isNotEmpty() }).joinToString(" · ")
        val pct = busiest?.percent
        val color = when {
            pct != null && pct >= 100 -> Color.parseColor("#FF4D6D")
            pct != null && pct >= 80 -> Color.parseColor("#FCA311")
            else -> Color.parseColor("#A1A1AA")
        }
        return text to color
    }

    fun planColors(pct: Int?): Pair<Int, Int> {
        val barColor = when {
            pct == null -> Color.parseColor("#71717A")
            pct >= 100 -> Color.parseColor("#FF4D6D")
            pct >= 80 -> Color.parseColor("#FCA311")
            else -> Color.parseColor("#FF6B35")
        }
        val textColor = when {
            pct == null -> Color.parseColor("#71717A")
            pct >= 100 -> Color.parseColor("#FF4D6D")
            pct >= 80 -> Color.parseColor("#FCA311")
            else -> Color.parseColor("#FFFFFF")
        }
        return barColor to textColor
    }

    fun planSubtext(p: WidgetPlan): String {
        if (!p.problem.isNullOrBlank()) {
            val label = when (p.problem) {
                "signin" -> "sign in again"
                "offline" -> "offline"
                "limited" -> "rate limited"
                "unreadable" -> "unreadable"
                else -> p.problem
            }
            return "⚠ $label"
        }
        val parts = mutableListOf<String>()
        if (p.limiter.isNotEmpty()) parts.add(p.limiter)
        if (p.resetText.isNotEmpty()) parts.add(p.resetText)
        if (p.fullInText.isNotEmpty()) parts.add("full ${p.fullInText}")
        if (p.secondaryText.isNotEmpty()) parts.add(p.secondaryText)
        if (p.credits != null && p.credits > 0) parts.add("$${p.credits.roundToInt()}")
        return if (parts.isNotEmpty()) parts.joinToString(" · ") else "signed in"
    }

    private fun parseIsoMs(iso: String): Long? {
        if (iso.isBlank()) return null
        return try {
            Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

    private fun formatAgo(iso: String, nowMs: Long): String {
        val stamp = parseIsoMs(iso) ?: return ""
        val seconds = max(0L, (nowMs - stamp) / 1000L)
        return when {
            seconds < 60 -> "now"
            seconds < 3600 -> "${seconds / 60}m"
            seconds < 86400 -> "${seconds / 3600}h"
            else -> "${seconds / 86400}d"
        }
    }

    private fun formatSpanUntil(iso: String, nowMs: Long): String {
        val stamp = parseIsoMs(iso) ?: return ""
        val diffMs = stamp - nowMs
        if (diffMs <= 0L) return ""
        val minutes = max(1L, ((diffMs + 30_000L) / 60_000L))
        if (minutes < 60L) return "${minutes}m"
        val hours = minutes / 60L
        if (hours < 48L) {
            val rem = minutes % 60L
            return if (rem > 0L) "${hours}h ${rem}m" else "${hours}h"
        }
        val days = hours / 24L
        val remHours = hours % 24L
        return if (remHours > 0L) "${days}d ${remHours}h" else "${days}d"
    }
}
