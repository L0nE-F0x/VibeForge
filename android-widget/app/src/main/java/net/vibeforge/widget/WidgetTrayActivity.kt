package net.vibeforge.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.WindowInsets
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

class WidgetTrayActivity : Activity() {

    private lateinit var backdrop: FrameLayout
    private lateinit var trayCard: LinearLayout
    private lateinit var statusPill: TextView
    private lateinit var summaryText: TextView
    private lateinit var syncText: TextView
    private lateinit var errorBanner: TextView
    private lateinit var machinesRow: LinearLayout
    private lateinit var trayScroll: ScrollView
    private lateinit var vibyCard: LinearLayout
    private lateinit var vibyTitle: TextView
    private lateinit var vibySub: TextView
    private lateinit var vibyGoBtn: TextView
    private lateinit var vibyCancelBtn: TextView
    private lateinit var vibyBtn: TextView
    private lateinit var sessionsHeader: TextView
    private lateinit var sessionsList: LinearLayout
    private lateinit var recentHeader: TextView
    private lateinit var recentList: LinearLayout
    private lateinit var plansHeader: TextView
    private lateinit var plansGrid: LinearLayout

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var topSystemInset = 0
    private var bottomSystemInset = 0
    private var positioned = false
    private var closing = false

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pollActive = false
    @Volatile
    private var refreshing = false
    private var latestDashboard: WidgetDashboard? = null

    /** Go and Cancel each take a second tap, so a brush against the tray carries out nothing. "go:<turn>" or "cancel:<turn>". */
    private var armedTurnId: String? = null
    private val disarmRunnable = Runnable {
        armedTurnId = null
        latestDashboard?.let { renderVibyCard(it) }
    }

    private var expandedKey: String? = null
    private var expandedPeekScreen: String = ""
    private var expandedCanSend: Boolean = true
    private var expandedLoading: Boolean = false
    private var expandedStatusMsg: String = ""
    private var expandedStatusColor: Int = Color.parseColor("#A1A1AA")
    private var draftReplyText: String = ""
    private var pendingForceText: String? = null

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!pollActive || isFinishing || isDestroyed) return
            triggerLiveRefresh(includeOtherMachines = false)
            mainHandler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        disableTransition(open = true)
        setContentView(R.layout.activity_tray)

        appWidgetId = intent?.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        backdrop = findViewById(R.id.tray_backdrop)
        trayCard = findViewById(R.id.tray_card)
        statusPill = findViewById(R.id.tray_status_pill)
        summaryText = findViewById(R.id.tray_summary_text)
        syncText = findViewById(R.id.tray_sync_text)
        errorBanner = findViewById(R.id.tray_error_banner)
        machinesRow = findViewById(R.id.tray_machines)
        trayScroll = findViewById(R.id.tray_scroll)
        vibyCard = findViewById(R.id.tray_viby_card)
        vibyTitle = findViewById(R.id.tray_viby_title)
        vibySub = findViewById(R.id.tray_viby_sub)
        vibyGoBtn = findViewById(R.id.tray_viby_go_btn)
        vibyCancelBtn = findViewById(R.id.tray_viby_cancel_btn)
        vibyBtn = findViewById(R.id.tray_btn_viby)
        sessionsHeader = findViewById(R.id.tray_sessions_header)
        sessionsList = findViewById(R.id.tray_sessions_list)
        recentHeader = findViewById(R.id.tray_recent_header)
        recentList = findViewById(R.id.tray_recent_list)
        plansHeader = findViewById(R.id.tray_plans_header)
        plansGrid = findViewById(R.id.tray_plans_grid)

        backdrop.setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val sys = insets.getInsets(
                    WindowInsets.Type.systemBars() or
                        WindowInsets.Type.displayCutout() or
                        WindowInsets.Type.ime()
                )
                topSystemInset = sys.top
                bottomSystemInset = sys.bottom
            } else {
                @Suppress("DEPRECATION")
                topSystemInset = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                bottomSystemInset = insets.systemWindowInsetBottom
            }
            positionTrayCard()
            insets
        }

        backdrop.setOnClickListener { dismissTray() }
        findViewById<View>(R.id.tray_btn_collapse).setOnClickListener { dismissTray() }
        findViewById<View>(R.id.tray_header_brand).setOnClickListener {
            openPage { VibeForgeApi.deskLink(it) }
        }
        // Viby on the phone page: at the plan waiting for Go, when there is one.
        vibyBtn.setOnClickListener {
            openPage { VibeForgeApi.vibyLink(it, latestDashboard?.viby) }
        }
        vibyCard.setOnClickListener {
            openPage { VibeForgeApi.vibyLink(it, latestDashboard?.viby) }
        }
        findViewById<View>(R.id.tray_btn_refresh).setOnClickListener {
            triggerLiveRefresh(includeOtherMachines = true)
        }
        findViewById<View>(R.id.tray_btn_config).setOnClickListener {
            startActivity(
                Intent(this, WidgetConfigActivity::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                }
            )
            finishNoAnim()
        }
        errorBanner.setOnClickListener {
            startActivity(
                Intent(this, WidgetConfigActivity::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                }
            )
            finishNoAnim()
        }

        renderMachines()
        renderDashboard(VibeForgeStore.getCachedDashboard(this), syncing = true)
        backdrop.post { positionTrayCard() }
        triggerLiveRefresh(includeOtherMachines = true)
    }

    override fun onResume() {
        super.onResume()
        pollActive = true
        mainHandler.removeCallbacks(pollRunnable)
        mainHandler.postDelayed(pollRunnable, POLL_INTERVAL_MS)
    }

    override fun onPause() {
        pollActive = false
        mainHandler.removeCallbacks(pollRunnable)
        mainHandler.removeCallbacks(disarmRunnable)
        super.onPause()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        appWidgetId = intent?.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        closing = false
        positioned = false
        expandedKey = null
        draftReplyText = ""
        trayCard.visibility = View.INVISIBLE
        renderMachines()
        renderDashboard(VibeForgeStore.getCachedDashboard(this), syncing = true)
        backdrop.post { positionTrayCard() }
        triggerLiveRefresh(includeOtherMachines = true)
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (expandedKey != null) {
            collapseExpandedSession()
            return
        }
        dismissTray()
    }

    /** One button per computer with live cached status dot. Hidden while there is only one. */
    private fun renderMachines() {
        val machines = VibeForgeStore.getMachines(this)
        machinesRow.removeAllViews()
        if (machines.size < 2) {
            machinesRow.visibility = View.GONE
            return
        }
        machinesRow.visibility = View.VISIBLE
        val activeId = VibeForgeStore.getActive(this)?.id
        for (machine in machines) {
            val selected = machine.id == activeId
            val cached = VibeForgeStore.getCachedDashboardFor(this, machine.id)
            val isWaiting = cached.waitingCount > 0 || cached.viby?.waitingTurnId?.isNotEmpty() == true
            val isWorking = cached.workingCount > 0 || cached.viby?.thinking == true || cached.viby?.runningTurn == true
            val prefix = when {
                isWaiting -> "● "
                isWorking -> "▸ "
                else -> ""
            }
            val color = when {
                selected -> "#FF6B35"
                isWaiting -> "#FCA311"
                isWorking -> "#FF6B35"
                else -> "#E4E4E7"
            }
            machinesRow.addView(
                TextView(this).apply {
                    text = "$prefix${machine.name}"
                    typeface = android.graphics.Typeface.MONOSPACE
                    textSize = 10.5f
                    maxLines = 1
                    setTextColor(Color.parseColor(color))
                    setBackgroundResource(if (selected) R.drawable.bg_pill_working else R.drawable.bg_btn)
                    setPadding(dp(9), dp(5), dp(9), dp(5))
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply {
                        marginEnd = dp(5)
                    }
                    setOnClickListener { switchTo(machine.id) }
                }
            )
        }
    }

    /** Shows another computer: what it last said at once, then what it says now. */
    private fun switchTo(machineId: String) {
        if (VibeForgeStore.getActive(this)?.id == machineId) return
        expandedKey = null
        draftReplyText = ""
        armedTurnId = null
        mainHandler.removeCallbacks(disarmRunnable)
        VibeForgeStore.setActive(applicationContext, machineId)
        renderMachines()
        renderDashboard(VibeForgeStore.getCachedDashboard(this), syncing = true)
        val mgr = AppWidgetManager.getInstance(applicationContext)
        val ids = mgr.getAppWidgetIds(ComponentName(applicationContext, VibeForgeWidgetProvider::class.java))
        if (ids.isNotEmpty()) {
            VibeForgeWidgetProvider.renderFromCache(applicationContext, mgr, ids, syncing = true)
        }
        backdrop.post { positionTrayCard() }
        triggerLiveRefresh(includeOtherMachines = false)
    }

    private fun triggerLiveRefresh(includeOtherMachines: Boolean) {
        if (refreshing) return
        refreshing = true
        syncText.text = "syncing…"
        val activeMachine = VibeForgeStore.getActive(this)
        VibeForgeApi.networkExecutor.execute {
            try {
                val fresh = VibeForgeApi.refreshNow(applicationContext, timeoutMs = 8_000)
                val mgr = AppWidgetManager.getInstance(applicationContext)
                val ids = mgr.getAppWidgetIds(ComponentName(applicationContext, VibeForgeWidgetProvider::class.java))
                if (ids.isNotEmpty()) {
                    VibeForgeWidgetProvider.renderFromCache(applicationContext, mgr, ids, syncing = false)
                }
                if (includeOtherMachines) {
                    val others = VibeForgeStore.getMachines(applicationContext).filter { it.id != activeMachine?.id }
                    for (other in others) {
                        VibeForgeApi.networkExecutor.execute {
                            VibeForgeApi.refreshMachine(applicationContext, other, timeoutMs = 6_000)
                            runOnUiThread {
                                if (!isFinishing && !isDestroyed) renderMachines()
                            }
                        }
                    }
                }
                runOnUiThread {
                    if (!isFinishing && !isDestroyed) {
                        renderMachines()
                        renderDashboard(fresh, syncing = false)
                        backdrop.post { positionTrayCard() }
                    }
                }
            } finally {
                refreshing = false
            }
        }
    }

    private fun renderDashboard(data: WidgetDashboard, syncing: Boolean, forceRebuildSessions: Boolean = false) {
        latestDashboard = data

        val (badgeText, badgeColor, badgeBg) = VibeForgeApi.statusBadge(data)
        statusPill.text = badgeText
        statusPill.setTextColor(badgeColor)
        statusPill.setBackgroundResource(badgeBg)

        val (summary, summaryColor) = VibeForgeApi.barSessionSummary(data)
        summaryText.text = summary
        summaryText.setTextColor(summaryColor)

        syncText.text = when {
            syncing -> "syncing…"
            data.updatedAtMs > 0L -> SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(data.updatedAtMs))
            else -> ""
        }

        if (!data.error.isNullOrBlank()) {
            errorBanner.visibility = View.VISIBLE
            errorBanner.text = data.error
        } else {
            errorBanner.visibility = View.GONE
        }

        renderVibyCard(data)

        val activeFocusedInReply = !forceRebuildSessions && isEditingExpandedReply()
        if (!activeFocusedInReply) {
            renderSessionsList(data)
            renderRecentList(data)
        }

        val inflater = LayoutInflater.from(this)
        plansGrid.removeAllViews()
        if (data.plans.isEmpty()) {
            plansHeader.visibility = View.GONE
        } else {
            plansHeader.visibility = View.VISIBLE
            var i = 0
            while (i < data.plans.size) {
                val rowLayout = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply {
                        bottomMargin = dp(5)
                    }
                    isBaselineAligned = false
                }
                for (col in 0..1) {
                    val idx = i + col
                    if (idx < data.plans.size) {
                        val p = data.plans[idx]
                        val tile = inflater.inflate(R.layout.item_tray_plan, rowLayout, false)
                        val lp = tile.layoutParams as LinearLayout.LayoutParams
                        if (col == 0) lp.marginEnd = dp(3) else lp.marginStart = dp(3)
                        tile.layoutParams = lp

                        val nameView = tile.findViewById<TextView>(R.id.item_plan_name)
                        val pctView = tile.findViewById<TextView>(R.id.item_plan_pct)
                        val barView = tile.findViewById<ProgressBar>(R.id.item_plan_bar)
                        val subView = tile.findViewById<TextView>(R.id.item_plan_sub)

                        nameView.text = p.name
                        val pct = p.percent
                        pctView.text = if (pct == null) "—" else "$pct%"
                        val (barColor, pctColor) = VibeForgeApi.planColors(pct)
                        pctView.setTextColor(pctColor)
                        barView.progress = (pct ?: 0).coerceIn(0, 100)
                        barView.progressTintList = ColorStateList.valueOf(barColor)
                        subView.text = VibeForgeApi.planSubtext(p)
                        tile.setOnClickListener { openPage { VibeForgeApi.deskLink(it) } }
                        rowLayout.addView(tile)
                    } else {
                        val spacer = View(this).apply {
                            layoutParams = LinearLayout.LayoutParams(0, 0, 1f).apply {
                                marginStart = dp(3)
                            }
                            visibility = View.INVISIBLE
                        }
                        rowLayout.addView(spacer)
                    }
                }
                plansGrid.addView(rowLayout)
                i += 2
            }
        }
    }

    private fun renderVibyCard(data: WidgetDashboard) {
        val viby = data.viby
        when {
            viby?.waitingTurnId?.isNotEmpty() == true -> {
                vibyBtn.text = "VIBY ●"
                vibyBtn.setTextColor(Color.parseColor("#FCA311"))
                vibyBtn.setBackgroundResource(R.drawable.bg_pill_waiting)
            }
            viby?.thinking == true || viby?.runningTurn == true -> {
                vibyBtn.text = "VIBY ▸"
                vibyBtn.setTextColor(Color.parseColor("#FF6B35"))
                vibyBtn.setBackgroundResource(R.drawable.bg_pill_working)
            }
            (viby?.copiesCount ?: 0) > 0 -> {
                vibyBtn.text = "VIBY · ${viby?.copiesCount}"
                vibyBtn.setTextColor(Color.parseColor("#E4E4E7"))
                vibyBtn.setBackgroundResource(R.drawable.bg_btn)
            }
            else -> {
                vibyBtn.text = "VIBY"
                vibyBtn.setTextColor(Color.parseColor("#E4E4E7"))
                vibyBtn.setBackgroundResource(R.drawable.bg_btn)
            }
        }

        if (viby == null || !viby.hasBanner) {
            vibyCard.visibility = View.GONE
            return
        }

        vibyCard.visibility = View.VISIBLE
        vibyCancelBtn.visibility = View.GONE
        when {
            viby.waitingTurnId.isNotEmpty() -> {
                vibyCard.setBackgroundResource(R.drawable.bg_session_waiting)
                vibyTitle.setTextColor(Color.parseColor("#FCA311"))
                // As the phone page's plan card: steps that can't run are skipped by Go; with none
                // that can, Go is off and the plan is fixed on the page (a tap on the card opens it there).
                val blocked = viby.blockedStepCount
                vibyTitle.text = when {
                    !viby.canGo -> "VIBY · FIX THE PLAN FIRST"
                    blocked > 0 -> "VIBY · PLAN WAITING · $blocked SKIPPED"
                    else -> "VIBY · PLAN WAITING"
                }
                vibySub.text = if (!viby.canGo) "No step can run as it is — tap to fix it on the phone page" else viby.waitingSummary
                vibyGoBtn.visibility = if (viby.canGo) View.VISIBLE else View.GONE
                vibyCancelBtn.visibility = View.VISIBLE
                vibyGoBtn.isEnabled = true
                vibyCancelBtn.isEnabled = true
                val goArmed = armedTurnId == "go:${viby.waitingTurnId}"
                vibyGoBtn.text = if (goArmed) "CONFIRM" else "GO"
                vibyGoBtn.setTextColor(Color.parseColor(if (goArmed) "#FF6B35" else "#FCA311"))
                vibyGoBtn.setBackgroundResource(if (goArmed) R.drawable.bg_pill_working else R.drawable.bg_pill_waiting)
                vibyGoBtn.setOnClickListener { onPlanTap("go", viby.waitingTurnId) }
                val cancelArmed = armedTurnId == "cancel:${viby.waitingTurnId}"
                vibyCancelBtn.text = if (cancelArmed) "CANCEL?" else "CANCEL"
                vibyCancelBtn.setTextColor(Color.parseColor(if (cancelArmed) "#FF4D6D" else "#A1A1AA"))
                vibyCancelBtn.setOnClickListener { onPlanTap("cancel", viby.waitingTurnId) }
            }
            viby.thinking || viby.runningTurn -> {
                vibyCard.setBackgroundResource(R.drawable.bg_session_working)
                vibyTitle.text = "VIBY · WORKING"
                vibyTitle.setTextColor(Color.parseColor("#FF6B35"))
                vibySub.text = viby.activityLabel.ifEmpty { "Viby is thinking…" }
                vibyGoBtn.visibility = View.GONE
            }
            else -> {
                vibyCard.setBackgroundResource(R.drawable.bg_card)
                vibyTitle.text = "VIBY · REVIEW"
                vibyTitle.setTextColor(Color.parseColor("#E4E4E7"))
                val noun = if (viby.copiesCount == 1) "copy" else "copies"
                vibySub.text = "${viby.copiesCount} Viby $noun waiting for review — tap to inspect"
                vibyGoBtn.visibility = View.GONE
            }
        }
    }

    /** Go or Cancel on the plan waiting: the first tap arms it, the second (within 4 s) sends it. */
    private fun onPlanTap(action: String, turnId: String) {
        val armed = "$action:$turnId"
        if (armedTurnId != armed) {
            armedTurnId = armed
            mainHandler.removeCallbacks(disarmRunnable)
            mainHandler.postDelayed(disarmRunnable, 4_000L)
            latestDashboard?.let { renderVibyCard(it) }
            return
        }
        mainHandler.removeCallbacks(disarmRunnable)
        armedTurnId = null
        vibyGoBtn.isEnabled = false
        vibyCancelBtn.isEnabled = false
        (if (action == "go") vibyGoBtn else vibyCancelBtn).text = "…"
        val machine = VibeForgeStore.getActive(this) ?: return
        VibeForgeApi.networkExecutor.execute {
            try {
                VibeForgeApi.postJson(
                    machine.url,
                    "/api/orchestrator/$action",
                    machine.key,
                    JSONObject().put("turnId", turnId),
                )
                VibeForgeApi.refreshMachine(applicationContext, machine, timeoutMs = 8_000)
                VibeForgeWidgetProvider.triggerRefresh(applicationContext)
                runOnUiThread {
                    if (!isFinishing && !isDestroyed) {
                        renderDashboard(VibeForgeStore.getCachedDashboard(this), syncing = false)
                        backdrop.post { positionTrayCard() }
                    }
                }
            } catch (e: Exception) {
                val said = failureText(machine, e, if (action == "go") "Couldn't run the plan" else "Couldn't cancel the plan")
                runOnUiThread {
                    if (!isFinishing && !isDestroyed) {
                        latestDashboard?.let { renderVibyCard(it) }
                        errorBanner.visibility = View.VISIBLE
                        errorBanner.text = said
                        backdrop.post { positionTrayCard() }
                    }
                }
            }
        }
    }

    private fun isEditingExpandedReply(): Boolean {
        if (expandedKey == null) return false
        if (draftReplyText.isNotEmpty()) return true
        val focused = currentFocus
        return focused is EditText && focused.id == R.id.item_session_input
    }

    private fun sessionKey(s: WidgetSession): String = "${s.ptyId}|${s.runId}"

    private fun collapseExpandedSession() {
        expandedKey = null
        expandedStatusMsg = ""
        draftReplyText = ""
        pendingForceText = null
        currentFocus?.clearFocus()
        latestDashboard?.let { renderDashboard(it, syncing = false, forceRebuildSessions = true) }
        backdrop.post { positionTrayCard() }
    }

    private fun renderSessionsList(data: WidgetDashboard) {
        val inflater = LayoutInflater.from(this)
        sessionsList.removeAllViews()
        if (data.sessions.isEmpty()) {
            sessionsHeader.text = "ACTIVE SESSIONS"
            val empty = TextView(this).apply {
                text = "No active sessions · Tap to open Desk"
                setTextColor(Color.parseColor("#71717A"))
                textSize = 11f
                typeface = android.graphics.Typeface.MONOSPACE
                setBackgroundResource(R.drawable.bg_card)
                setPadding(dp(10), dp(8), dp(10), dp(8))
                setOnClickListener { openPage { VibeForgeApi.deskLink(it) } }
            }
            sessionsList.addView(empty)
            return
        }

        sessionsHeader.text = "ACTIVE SESSIONS (${data.sessions.size})"
        for (s in data.sessions) {
            sessionsList.addView(buildSessionRow(inflater, sessionsList, s, data.nudges))
        }
    }

    private fun renderRecentList(data: WidgetDashboard) {
        val inflater = LayoutInflater.from(this)
        recentList.removeAllViews()
        if (data.recentDone.isEmpty()) {
            recentHeader.visibility = View.GONE
            recentList.visibility = View.GONE
            return
        }
        recentHeader.visibility = View.VISIBLE
        recentList.visibility = View.VISIBLE
        for (s in data.recentDone) {
            recentList.addView(buildSessionRow(inflater, recentList, s, data.nudges))
        }
    }

    private fun buildSessionRow(
        inflater: LayoutInflater,
        parent: LinearLayout,
        s: WidgetSession,
        nudges: List<String>,
    ): View {
        val row = inflater.inflate(R.layout.item_tray_session, parent, false)
        val mainArea = row.findViewById<View>(R.id.item_session_main)
        val title = row.findViewById<TextView>(R.id.item_session_title)
        val sub = row.findViewById<TextView>(R.id.item_session_sub)
        val peekBtn = row.findViewById<TextView>(R.id.item_session_peek_btn)
        val badge = row.findViewById<TextView>(R.id.item_session_badge)
        val drawer = row.findViewById<LinearLayout>(R.id.item_session_drawer)
        val screenView = row.findViewById<TextView>(R.id.item_session_screen)
        val drawerStatus = row.findViewById<TextView>(R.id.item_session_drawer_status)
        val openFull = row.findViewById<TextView>(R.id.item_session_open_full)
        val nudgesScroll = row.findViewById<View>(R.id.item_session_nudges_scroll)
        val nudgesRow = row.findViewById<LinearLayout>(R.id.item_session_nudges)
        val composeRow = row.findViewById<View>(R.id.item_session_compose)
        val input = row.findViewById<EditText>(R.id.item_session_input)
        val sendBtn = row.findViewById<TextView>(R.id.item_session_send)

        title.text = s.title
        sub.text = VibeForgeApi.sessionSubtitle(s)
        when (s.state) {
            "waiting" -> {
                row.setBackgroundResource(R.drawable.bg_session_waiting)
                badge.text = "WAITING"
                badge.setTextColor(Color.parseColor("#FCA311"))
                badge.setBackgroundResource(R.drawable.bg_pill_waiting)
            }
            "working" -> {
                row.setBackgroundResource(R.drawable.bg_session_working)
                badge.text = "WORKING"
                badge.setTextColor(Color.parseColor("#FF6B35"))
                badge.setBackgroundResource(R.drawable.bg_pill_working)
            }
            else -> {
                row.setBackgroundResource(R.drawable.bg_card)
                badge.text = "DONE"
                badge.setTextColor(Color.parseColor("#A1A1AA"))
                badge.setBackgroundResource(R.drawable.bg_pill_quiet)
            }
        }

        val key = sessionKey(s)
        val isExpanded = expandedKey == key
        peekBtn.text = if (isExpanded) "▴" else "›_"
        peekBtn.setTextColor(Color.parseColor(if (isExpanded) "#FCA311" else "#E4E4E7"))

        mainArea.setOnClickListener {
            openPage { VibeForgeApi.sessionLink(it, s) }
        }
        peekBtn.setOnClickListener {
            toggleSessionPeek(s)
        }

        if (!isExpanded) {
            drawer.visibility = View.GONE
            return row
        }

        drawer.visibility = View.VISIBLE
        screenView.text = when {
            expandedLoading && expandedPeekScreen.isEmpty() -> "Loading terminal…"
            expandedPeekScreen.isNotEmpty() -> expandedPeekScreen
            else -> "Nothing on screen yet."
        }
        drawerStatus.text = expandedStatusMsg
        drawerStatus.setTextColor(expandedStatusColor)
        openFull.setOnClickListener {
            openPage { VibeForgeApi.sessionLink(it, s) }
        }

        val showSend = expandedCanSend && (s.ptyId.isNotEmpty() || s.runId.isNotEmpty())
        nudgesScroll.visibility = if (showSend && nudges.isNotEmpty()) View.VISIBLE else View.GONE
        composeRow.visibility = if (showSend) View.VISIBLE else View.GONE

        if (showSend) {
            nudgesRow.removeAllViews()
            for (nudge in nudges) {
                nudgesRow.addView(
                    TextView(this).apply {
                        text = nudge
                        typeface = android.graphics.Typeface.MONOSPACE
                        textSize = 9.5f
                        maxLines = 1
                        setTextColor(Color.parseColor("#E4E4E7"))
                        setBackgroundResource(R.drawable.bg_btn)
                        setPadding(dp(8), dp(5), dp(8), dp(5))
                        layoutParams = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT,
                        ).apply {
                            marginEnd = dp(5)
                        }
                        setOnClickListener {
                            sendToSession(s, nudge, screenView, drawerStatus)
                        }
                    }
                )
            }

            if (input.text.toString() != draftReplyText) {
                input.setText(draftReplyText)
                input.setSelection(draftReplyText.length)
            }
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(cs: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(cs: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(editable: Editable?) {
                    draftReplyText = editable?.toString().orEmpty()
                    if (pendingForceText != null && pendingForceText != draftReplyText.trim()) {
                        pendingForceText = null
                    }
                }
            })
            input.setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    sendToSession(s, input.text.toString(), screenView, drawerStatus)
                    true
                } else {
                    false
                }
            }
            sendBtn.setOnClickListener {
                sendToSession(s, input.text.toString(), screenView, drawerStatus)
            }
        }

        return row
    }

    private fun toggleSessionPeek(s: WidgetSession) {
        val key = sessionKey(s)
        if (expandedKey == key) {
            collapseExpandedSession()
            return
        }
        expandedKey = key
        expandedPeekScreen = ""
        expandedCanSend = s.ptyId.isNotEmpty() || s.runId.isNotEmpty()
        expandedLoading = true
        expandedStatusMsg = ""
        draftReplyText = ""
        pendingForceText = null
        currentFocus?.clearFocus()
        latestDashboard?.let { renderDashboard(it, syncing = false, forceRebuildSessions = true) }
        backdrop.post { positionTrayCard() }

        val machine = VibeForgeStore.getActive(this) ?: return
        VibeForgeApi.networkExecutor.execute {
            try {
                val peek = VibeForgeApi.fetchSessionPeek(machine.url, machine.key, s.ptyId, s.runId)
                val tail = VibeForgeApi.tailScreenLines(peek.screen, maxLines = 8)
                runOnUiThread {
                    if (isFinishing || isDestroyed || expandedKey != key) return@runOnUiThread
                    expandedLoading = false
                    expandedPeekScreen = tail
                    expandedCanSend = peek.canSend
                    if (!peek.canSend) {
                        expandedStatusMsg = "Ended session can't be continued"
                        expandedStatusColor = Color.parseColor("#71717A")
                    }
                    latestDashboard?.let { renderDashboard(it, syncing = false, forceRebuildSessions = true) }
                    backdrop.post { positionTrayCard() }
                }
            } catch (e: Exception) {
                val said = failureText(machine, e, "Couldn't load screen")
                runOnUiThread {
                    if (isFinishing || isDestroyed || expandedKey != key) return@runOnUiThread
                    expandedLoading = false
                    expandedPeekScreen = said
                    latestDashboard?.let { renderDashboard(it, syncing = false, forceRebuildSessions = true) }
                    backdrop.post { positionTrayCard() }
                }
            }
        }
    }

    private fun sendToSession(
        s: WidgetSession,
        rawText: String,
        screenView: TextView,
        statusView: TextView,
    ) {
        val text = rawText.trim()
        if (text.isEmpty()) return
        val key = sessionKey(s)
        val machine = VibeForgeStore.getActive(this) ?: return
        val force = pendingForceText == text

        expandedStatusMsg = if (force) "Sending anyway…" else "Sending…"
        expandedStatusColor = Color.parseColor("#FCA311")
        statusView.text = expandedStatusMsg
        statusView.setTextColor(expandedStatusColor)

        VibeForgeApi.networkExecutor.execute {
            try {
                val reply = VibeForgeApi.postJson(
                    machine.url,
                    "/api/send",
                    machine.key,
                    JSONObject()
                        .put("ptyId", s.ptyId)
                        .put("runId", s.runId)
                        .put("text", text)
                        .put("force", force),
                )
                val nextPty = if (reply.isNull("ptyId")) s.ptyId else reply.optString("ptyId", s.ptyId)
                val nextRun = if (reply.isNull("runId")) s.runId else reply.optString("runId", s.runId)
                val peek = try {
                    VibeForgeApi.fetchSessionPeek(machine.url, machine.key, nextPty, nextRun)
                } catch (_: Exception) {
                    null
                }
                VibeForgeApi.refreshMachine(applicationContext, machine, timeoutMs = 8_000)
                VibeForgeWidgetProvider.triggerRefresh(applicationContext)
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    pendingForceText = null
                    draftReplyText = ""
                    currentFocus?.clearFocus()
                    if (expandedKey == key) {
                        expandedKey = "$nextPty|$nextRun"
                        if (peek != null) {
                            expandedPeekScreen = VibeForgeApi.tailScreenLines(peek.screen, 8)
                            screenView.text = expandedPeekScreen
                        }
                        expandedStatusMsg = "Sent!"
                        expandedStatusColor = Color.parseColor("#34D399")
                    }
                    renderDashboard(VibeForgeStore.getCachedDashboard(this), syncing = false, forceRebuildSessions = true)
                    backdrop.post { positionTrayCard() }
                }
            } catch (e: ApiHttpException) {
                runOnUiThread {
                    if (isFinishing || isDestroyed || expandedKey != key) return@runOnUiThread
                    if (e.working && !force) {
                        pendingForceText = text
                        draftReplyText = text
                        expandedStatusMsg = "Still working — tap SEND again to force"
                        expandedStatusColor = Color.parseColor("#FCA311")
                    } else {
                        pendingForceText = null
                        expandedStatusMsg = failureText(machine, e, "Failed to send")
                        expandedStatusColor = Color.parseColor("#FF4D6D")
                    }
                    statusView.text = expandedStatusMsg
                    statusView.setTextColor(expandedStatusColor)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    if (isFinishing || isDestroyed || expandedKey != key) return@runOnUiThread
                    pendingForceText = null
                    expandedStatusMsg = e.message ?: "Offline — check Tailscale"
                    expandedStatusColor = Color.parseColor("#FF4D6D")
                    statusView.text = expandedStatusMsg
                    statusView.setTextColor(expandedStatusColor)
                }
            }
        }
    }

    private fun positionTrayCard() {
        val rootHeight = backdrop.height
        if (rootHeight <= 0) return

        val topMin = topSystemInset + dp(10)
        val bottomMax = rootHeight - bottomSystemInset - dp(12)
        val maxCardHeight = max(dp(220), bottomMax - topMin)

        // Cap ScrollView height so the card never overflows off screen
        val chromeHeight = dp(if (machinesRow.visibility == View.VISIBLE) 149 else 115)
        val maxScrollH = max(dp(120), maxCardHeight - chromeHeight)
        trayScroll.measure(
            View.MeasureSpec.makeMeasureSpec(max(1, backdrop.width - dp(44)), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(maxScrollH, View.MeasureSpec.AT_MOST),
        )
        val scrollLp = trayScroll.layoutParams
        scrollLp.height = min(trayScroll.measuredHeight, maxScrollH)
        trayScroll.layoutParams = scrollLp

        trayCard.measure(
            View.MeasureSpec.makeMeasureSpec(max(1, backdrop.width - dp(20)), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(maxCardHeight, View.MeasureSpec.AT_MOST),
        )
        val cardHeight = trayCard.measuredHeight

        val rootLoc = IntArray(2)
        backdrop.getLocationOnScreen(rootLoc)
        val bounds: Rect? = intent?.sourceBounds
        val anchorAdjust = if (bounds != null && bounds.height() < dp(36)) {
            dp(intent?.getIntExtra(EXTRA_ANCHOR_OFFSET_DP, 5) ?: 5)
        } else {
            0
        }

        val desiredTop = if (bounds != null && bounds.top > 0) {
            val anchorTop = bounds.top - rootLoc[1] - anchorAdjust
            if (anchorTop + cardHeight <= bottomMax) {
                anchorTop
            } else {
                bottomMax - cardHeight
            }
        } else {
            topMin + dp(6)
        }

        val clampedTop = max(topMin, min(desiredTop, max(topMin, bottomMax - cardHeight)))
        val cardLp = trayCard.layoutParams as FrameLayout.LayoutParams
        if (cardLp.topMargin != clampedTop) {
            cardLp.topMargin = clampedTop
            trayCard.layoutParams = cardLp
        }

        if (!positioned) {
            positioned = true
            trayCard.alpha = 0f
            trayCard.translationY = -dp(8).toFloat()
            trayCard.visibility = View.VISIBLE
            trayCard.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(150L)
                .setInterpolator(DecelerateInterpolator())
                .start()
        }
    }

    /** Opens the computer's phone page at a place (VibeForgeApi's links), and closes the tray. */
    private fun openPage(link: (String) -> String) {
        val baseUrl = VibeForgeStore.getUrl(this).ifBlank { BuildConfig.DEFAULT_URL }.trimEnd('/')
        if (baseUrl.isNotEmpty()) {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(link(baseUrl))).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
            )
        }
        finishNoAnim()
    }

    /** A refusal of the widget's key ends with the widget asking to pair again; anything else is said as it came. */
    private fun failureText(machine: Machine, e: Exception, fallback: String): String {
        if (e is ApiHttpException && e.status == 401) {
            VibeForgeApi.keyRejected(applicationContext, machine)
            VibeForgeWidgetProvider.triggerRefresh(applicationContext)
            return VibeForgeApi.keyRejectedText(machine.name)
        }
        return e.message ?: fallback
    }

    private fun dismissTray() {
        if (closing) return
        closing = true
        trayCard.animate()
            .alpha(0f)
            .translationY(-dp(8).toFloat())
            .setDuration(100L)
            .withEndAction { finishNoAnim() }
            .start()
    }

    private fun finishNoAnim() {
        finish()
        disableTransition(open = false)
    }

    private fun disableTransition(open: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val type = if (open) OVERRIDE_TRANSITION_OPEN else OVERRIDE_TRANSITION_CLOSE
            overrideActivityTransition(type, 0, 0)
        } else {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_ANCHOR_OFFSET_DP = "anchor_offset_dp"
        private const val POLL_INTERVAL_MS = 5_000L
    }
}
