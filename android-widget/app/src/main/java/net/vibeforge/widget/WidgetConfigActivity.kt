package net.vibeforge.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The widget's computers: one tab each, with its name and address, and "+ ADD" for another. A
 * computer is paired here once: its pairing code goes to the computer (POST /api/pair), which hands
 * this widget a key of its own. Only the key is kept, sealed in the Android Keystore; the code is
 * not. Saving a computer puts it on show.
 */
class WidgetConfigActivity : Activity() {

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    /** The computer whose fields are shown. Null while a new one is being typed in. */
    private var editingId: String? = null

    private lateinit var tabs: LinearLayout
    private lateinit var nameInput: EditText
    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView
    private lateinit var saveBtn: Button
    private lateinit var removeBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
            setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        }

        setContentView(R.layout.activity_config)

        tabs = findViewById(R.id.machine_tabs)
        nameInput = findViewById(R.id.input_name)
        urlInput = findViewById(R.id.input_url)
        tokenInput = findViewById(R.id.input_token)
        statusText = findViewById(R.id.config_status)
        saveBtn = findViewById(R.id.btn_save)
        removeBtn = findViewById(R.id.btn_remove)
        val pasteBtn = findViewById<Button>(R.id.btn_paste_link)
        val openPwaBtn = findViewById<Button>(R.id.btn_open_pwa)

        editingId = VibeForgeStore.getActive(this)?.id
        showEditing()

        pasteBtn.setOnClickListener { pasteFromClipboard() }
        saveBtn.setOnClickListener { save() }
        removeBtn.setOnClickListener { remove() }
        openPwaBtn.setOnClickListener {
            val typed = VibeForgeStore.normalizeUrl(VibeForgeStore.splitLink(urlInput.text.toString()).first)
            val url = typed.ifEmpty { VibeForgeStore.getUrl(this) }
            if (url.isNotEmpty()) {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(VibeForgeApi.deskLink(url))))
            }
        }
    }

    private fun pasteFromClipboard() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip = clipboard?.primaryClip
        val raw = if (clip != null && clip.itemCount > 0) {
            clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
        } else {
            ""
        }
        if (raw.isBlank()) {
            say("Clipboard is empty. Copy the pairing link from Settings → Phone first.", "#FCA311")
            return
        }
        val (cleanUrl, code, recognized) = VibeForgeStore.extractClipboardPairing(applicationContext, raw)
        if (!recognized) {
            say("Clipboard didn't look like a VibeForge pairing link or code.", "#FCA311")
            return
        }
        if (cleanUrl != null) urlInput.setText(cleanUrl)
        if (code.isNotEmpty()) tokenInput.setText(code)
        say("Pasted from clipboard — tap Pair to connect.", "#34D399")
    }

    /** The tabs, and the fields of the computer being edited (empty for a new one). */
    private fun showEditing() {
        val machines = VibeForgeStore.getMachines(this)
        val editing = machines.firstOrNull { it.id == editingId }
        if (editing == null) editingId = null
        nameInput.setText(editing?.name.orEmpty())
        // A first computer starts with the address this build was made for, if it was given one.
        urlInput.setText(editing?.url ?: if (machines.isEmpty()) BuildConfig.DEFAULT_URL.trim() else "")
        // The code is never kept: the field is for pairing (again), and empty keeps the key there is.
        tokenInput.setText("")
        tokenInput.hint = if (editing?.paired == true) "paired · enter a code only to pair again" else "vf_…"
        saveBtn.text = if (editing?.paired == true) "SAVE & SHOW THIS COMPUTER" else "PAIR & SHOW THIS COMPUTER"
        if (statusText.visibility != View.VISIBLE) {
            when {
                editing?.paired == true -> say("Paired with ${editing.name}. It lists this widget in Settings → Phone, where Remove signs it out.", "#A1A1AA")
                editing != null -> say("Not paired. Enter the pairing code from Settings → Phone on ${editing.name}.", "#FCA311")
            }
        }
        // The last computer stays: the widget needs one to show.
        removeBtn.visibility = if (editing != null && machines.size > 1) View.VISIBLE else View.GONE

        tabs.removeAllViews()
        for (machine in machines) {
            tabs.addView(
                tab(machine.name, machine.id == editingId) {
                    editingId = machine.id
                    statusText.visibility = View.GONE
                    showEditing()
                }
            )
        }
        tabs.addView(
            tab("+ ADD", editingId == null) {
                editingId = null
                statusText.visibility = View.GONE
                showEditing()
            }
        )
    }

    private fun tab(label: String, selected: Boolean, onTap: () -> Unit): TextView =
        TextView(this).apply {
            text = label
            typeface = Typeface.MONOSPACE
            textSize = 12f
            maxLines = 1
            setTextColor(Color.parseColor(if (selected) "#FF6B35" else "#E4E4E7"))
            setBackgroundResource(if (selected) R.drawable.bg_pill_working else R.drawable.bg_btn)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginEnd = dp(6)
            }
            setOnClickListener { onTap() }
        }

    private fun say(text: String, color: String) {
        statusText.visibility = View.VISIBLE
        statusText.setTextColor(Color.parseColor(color))
        statusText.text = text
    }

    private fun save() {
        // The whole link from Settings → Phone may be pasted as the address: it carries the code.
        val (address, linkCode) = VibeForgeStore.splitLink(urlInput.text.toString())
        val url = VibeForgeStore.cleanAddress(applicationContext, address)
        val code = tokenInput.text.toString().trim().ifEmpty { linkCode }
        val typedName = nameInput.text.toString().trim()
        // Nothing that isn't an address is kept: the widget would only fail on it later.
        if (url == null) {
            say(
                if (address.contains("tailscale")) {
                    "That is the command for the computer's own terminal, not its address. Type the computer's Tailscale name here, like apexforgelaptop."
                } else {
                    "That doesn't look like a computer's address. Type its Tailscale name, like apexforgelaptop."
                },
                "#FF4D6D",
            )
            return
        }
        val editing = VibeForgeStore.getMachines(this).firstOrNull { it.id == editingId }
        // A key is only good at the address that gave it.
        val keepKey = editing?.paired == true && VibeForgeStore.normalizeUrl(editing.url) == url
        if (code.isEmpty()) {
            if (keepKey) {
                // Only the name changed: nothing to ask the computer.
                val machine = VibeForgeStore.saveMachine(applicationContext, editingId, typedName, url, key = null) ?: return
                VibeForgeStore.setActive(applicationContext, machine.id)
                editingId = machine.id
                statusText.visibility = View.GONE
                showEditing()
                VibeForgeWidgetProvider.triggerRefresh(applicationContext)
                say("Saved.", "#34D399")
                return
            }
            say("Enter the pairing code from Settings → Phone on that computer.", "#FF4D6D")
            return
        }

        saveBtn.isEnabled = false
        say("Pairing with ${typedName.ifEmpty { VibeForgeStore.defaultName(url) }}…", "#FCA311")
        val id = editingId
        VibeForgeApi.networkExecutor.execute {
            val outcome: Result<Machine> = try {
                val pairing = VibeForgeApi.pair(url, code)
                val machine = VibeForgeStore.saveMachine(applicationContext, id, typedName, url, pairing.key, pairing.computer)
                    ?: throw IllegalStateException("This phone couldn't keep the key safely (Android Keystore refused). Nothing was saved.")
                VibeForgeStore.setActive(applicationContext, machine.id)
                Result.success(machine)
            } catch (e: ApiHttpException) {
                Result.failure(e)
            } catch (e: IllegalStateException) {
                Result.failure(e)
            } catch (_: Exception) {
                Result.failure(IllegalStateException("Couldn't reach that computer. Is VibeForge running there with Settings → Phone on, and is Tailscale connected on this phone?"))
            }
            val machine = outcome.getOrNull()
            val ok = machine != null && VibeForgeApi.refreshMachine(applicationContext, machine, timeoutMs = 8_000)
            VibeForgeWidgetProvider.triggerRefresh(applicationContext)

            runOnUiThread {
                saveBtn.isEnabled = true
                if (machine == null) {
                    say(outcome.exceptionOrNull()?.message ?: "Couldn't pair.", "#FF4D6D")
                    return@runOnUiThread
                }
                editingId = machine.id
                // The code did its work: it is not kept, not even in the field.
                tokenInput.setText("")
                statusText.visibility = View.GONE
                showEditing()
                if (ok) {
                    say("Paired with ${machine.name}. The widget has a key of its own now; the code is forgotten.", "#34D399")
                    if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                        setResult(
                            RESULT_OK,
                            Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
                        )
                        finish()
                    }
                } else {
                    val err = VibeForgeStore.getCachedDashboardFor(applicationContext, machine.id).error
                        ?: "Offline — check Tailscale"
                    say("Paired, but couldn't read ${machine.name} just now: $err", "#FF4D6D")
                }
            }
        }
    }

    private fun remove() {
        val id = editingId ?: return
        VibeForgeStore.removeMachine(applicationContext, id)
        editingId = VibeForgeStore.getActive(this)?.id
        showEditing()
        say("Removed.", "#A1A1AA")
        VibeForgeWidgetProvider.triggerRefresh(applicationContext)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
