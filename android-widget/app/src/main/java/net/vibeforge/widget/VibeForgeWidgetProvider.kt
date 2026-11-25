package net.vibeforge.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews

class VibeForgeWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        renderFromCache(context, appWidgetManager, appWidgetIds, syncing = true)
        refreshAsync(context, goAsync())
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
        renderFromCache(context, appWidgetManager, intArrayOf(appWidgetId), syncing = false)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            ACTION_REFRESH,
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                val mgr = AppWidgetManager.getInstance(context)
                val ids = mgr.getAppWidgetIds(ComponentName(context, VibeForgeWidgetProvider::class.java))
                if (ids.isNotEmpty()) {
                    renderFromCache(context, mgr, ids, syncing = true)
                    refreshAsync(context, goAsync())
                }
            }
        }
    }

    companion object {
        const val ACTION_REFRESH = "net.vibeforge.widget.ACTION_REFRESH"
        private const val OVERSIZE_HEIGHT_DP = 155

        fun triggerRefresh(context: Context) {
            val intent = Intent(context, VibeForgeWidgetProvider::class.java).apply {
                action = ACTION_REFRESH
            }
            context.sendBroadcast(intent)
        }

        private fun refreshAsync(context: Context, pendingResult: PendingResult?) {
            val appContext = context.applicationContext
            VibeForgeApi.networkExecutor.execute {
                try {
                    VibeForgeApi.refreshNow(appContext, timeoutMs = 4_500)
                } finally {
                    val mgr = AppWidgetManager.getInstance(appContext)
                    val ids = mgr.getAppWidgetIds(ComponentName(appContext, VibeForgeWidgetProvider::class.java))
                    if (ids.isNotEmpty()) {
                        renderFromCache(appContext, mgr, ids, syncing = false)
                    }
                    pendingResult?.finish()
                }
            }
        }

        fun renderFromCache(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetIds: IntArray,
            syncing: Boolean,
        ) {
            val dashboard = VibeForgeStore.getCachedDashboard(context)
            val baseUrl = VibeForgeStore.getUrl(context).ifBlank { BuildConfig.DEFAULT_URL }
            // With several computers, the bar names the one on show.
            val machineName = if (VibeForgeStore.getMachines(context).size > 1) VibeForgeStore.getActive(context)?.name.orEmpty() else ""

            for (widgetId in appWidgetIds) {
                val options = appWidgetManager.getAppWidgetOptions(widgetId)
                val effectiveH = effectiveWidgetHeightDp(options)
                val views = buildRemoteViews(context, widgetId, baseUrl, machineName, dashboard, syncing, effectiveH)
                appWidgetManager.updateAppWidget(widgetId, views)
            }
        }

        private fun effectiveWidgetHeightDp(options: Bundle?): Int {
            if (options == null) return 0
            val maxH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0)
            val minH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)
            return if (maxH > 0) maxH else minH
        }

        private fun buildRemoteViews(
            context: Context,
            widgetId: Int,
            baseUrl: String,
            machineName: String,
            data: WidgetDashboard,
            syncing: Boolean,
            effectiveHeightDp: Int,
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_vibeforge)

            // Header brand -> Open PWA Desk
            views.setOnClickPendingIntent(
                R.id.header_brand,
                browserIntent(context, widgetId * 100 + 1, VibeForgeApi.deskLink(baseUrl)),
            )

            // Viby shortcut -> the phone page's Viby (at the plan waiting for Go, when one is), lit when waiting / working / copies to review
            val viby = data.viby
            val (vibyText, vibyColor, vibyBg) = when {
                viby?.waitingTurnId?.isNotEmpty() == true ->
                    Triple("VIBY ●", Color.parseColor("#FCA311"), R.drawable.bg_pill_waiting)
                viby?.thinking == true || viby?.runningTurn == true ->
                    Triple("VIBY ▸", Color.parseColor("#FF6B35"), R.drawable.bg_pill_working)
                (viby?.copiesCount ?: 0) > 0 ->
                    Triple("VIBY · ${viby?.copiesCount}", Color.parseColor("#E4E4E7"), R.drawable.bg_btn)
                else ->
                    Triple("VIBY", Color.parseColor("#E4E4E7"), R.drawable.bg_btn)
            }
            views.setTextViewText(R.id.btn_viby, vibyText)
            views.setTextColor(R.id.btn_viby, vibyColor)
            views.setInt(R.id.btn_viby, "setBackgroundResource", vibyBg)
            views.setOnClickPendingIntent(
                R.id.btn_viby,
                browserIntent(context, widgetId * 100 + 2, VibeForgeApi.vibyLink(baseUrl, viby)),
            )

            // Refresh -> Broadcast ACTION_REFRESH
            val refreshIntent = Intent(context, VibeForgeWidgetProvider::class.java).apply {
                action = ACTION_REFRESH
            }
            val refreshPending = PendingIntent.getBroadcast(
                context,
                widgetId * 100 + 3,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.btn_refresh, refreshPending)

            // Settings gear -> Open WidgetConfigActivity
            val configIntent = Intent(context, WidgetConfigActivity::class.java).apply {
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val configPending = PendingIntent.getActivity(
                context,
                widgetId * 100 + 4,
                configIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.btn_config, configPending)

            // Maximize chevron -> Overlay tray floating over apps & folders underneath
            views.setOnClickPendingIntent(
                R.id.btn_toggle,
                trayPendingIntent(context, widgetId, requestOffset = 6, uriSuffix = "toggle", anchorOffsetDp = 5),
            )

            // Status pill
            val (badgeText, badgeColor, badgeBg) = VibeForgeApi.statusBadge(data)
            views.setTextViewText(R.id.status_pill, badgeText)
            views.setTextColor(R.id.status_pill, badgeColor)
            views.setInt(R.id.status_pill, "setBackgroundResource", badgeBg)

            // Bottom strip left: lead active session / Viby / recent done / status
            val (barSummary, barSummaryColor) = VibeForgeApi.barSessionSummary(data)
            views.setTextViewText(R.id.bar_summary_text, if (machineName.isNotEmpty()) "$machineName · $barSummary" else barSummary)
            views.setTextColor(R.id.bar_summary_text, barSummaryColor)
            val leadSession = data.sessions.firstOrNull()
            val recentBar = VibeForgeApi.recentBarSession(data)
            // Not paired (or no longer): the summary says so, and a tap opens the setup screen.
            val unpaired = VibeForgeStore.getActive(context)?.paired != true
            val summaryIntent = when {
                unpaired || (!data.error.isNullOrBlank() && leadSession == null) -> configPending
                leadSession != null -> browserIntent(context, widgetId * 100 + 8, VibeForgeApi.sessionLink(baseUrl, leadSession))
                viby?.hasBanner == true -> browserIntent(context, widgetId * 100 + 8, VibeForgeApi.vibyLink(baseUrl, viby))
                recentBar != null -> browserIntent(context, widgetId * 100 + 8, VibeForgeApi.sessionLink(baseUrl, recentBar))
                else -> browserIntent(context, widgetId * 100 + 8, VibeForgeApi.deskLink(baseUrl))
            }
            views.setOnClickPendingIntent(R.id.bar_summary_text, summaryIntent)

            // Bottom strip right: busiest plan % + sync time -> also opens dropdown tray
            val (barMeta, barMetaColor) = VibeForgeApi.barMetaSummary(data, syncing)
            views.setTextViewText(R.id.bar_meta_text, barMeta)
            views.setTextColor(R.id.bar_meta_text, barMetaColor)
            views.setOnClickPendingIntent(
                R.id.bar_meta_text,
                trayPendingIntent(context, widgetId, requestOffset = 7, uriSuffix = "meta", anchorOffsetDp = 26),
            )

            // Alert only when the launcher host is still reserving 3+ rows (legacy v1.0 upgrade)
            if (effectiveHeightDp >= OVERSIZE_HEIGHT_DP) {
                views.setViewVisibility(R.id.oversize_notice, View.VISIBLE)
                views.setOnClickPendingIntent(R.id.oversize_notice, configPending)
            } else {
                views.setViewVisibility(R.id.oversize_notice, View.GONE)
            }

            return views
        }

        private fun trayPendingIntent(
            context: Context,
            widgetId: Int,
            requestOffset: Int,
            uriSuffix: String,
            anchorOffsetDp: Int,
        ): PendingIntent {
            val intent = Intent(context, WidgetTrayActivity::class.java).apply {
                setData(Uri.parse("vibeforge://widget/$widgetId/tray-$uriSuffix"))
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                putExtra(WidgetTrayActivity.EXTRA_ANCHOR_OFFSET_DP, anchorOffsetDp)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            return PendingIntent.getActivity(
                context,
                widgetId * 100 + requestOffset,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun browserIntent(context: Context, requestCode: Int, url: String): PendingIntent {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            return PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
