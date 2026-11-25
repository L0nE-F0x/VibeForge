package net.vibeforge.widget

import android.Manifest
import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * The widget's computers: one tab each, with its name and address, and "+ ADD" for another. A
 * computer is paired here once: its pairing code goes to the computer (POST /api/pair), which hands
 * this widget a key of its own. Only the key is kept, sealed in the Android Keystore; the code is
 * not. Saving a computer puts it on show.
 *
 * Pairing starts with Scan: the camera (ScanActivity) reads the QR code Settings → Phone shows, and
 * the address and code in it pair at once, a new computer or one already here whose key went. The
 * typed form (address, code, or the pasted link) stays below it, folded away, for a phone without a
 * camera or a person who'd rather type.
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
    private lateinit var scanBtn: Button
    private lateinit var typeToggle: Button
    private lateinit var manualForm: View

    /** Whether the typed form is unfolded. */
    private var formOpen = false

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
        // Android 15 draws the window under the status and navigation bars and the keyboard, and no
        // longer shrinks it for the keyboard. The page keeps clear of the bars, and ends where the
        // keyboard begins, so the field being typed in scrolls into sight above it, as before.
        findViewById<View>(R.id.config_root).setOnApplyWindowInsetsListener { view, insets ->
            @Suppress("DEPRECATION")
            val top = insets.systemWindowInsetTop
            @Suppress("DEPRECATION")
            val bottom = insets.systemWindowInsetBottom
            view.setPadding(0, top, 0, 0)
            val params = view.layoutParams as? ViewGroup.MarginLayoutParams
            if (params != null && params.bottomMargin != bottom) {
                params.bottomMargin = bottom
                view.layoutParams = params
            }
            insets
        }

        tabs = findViewById(R.id.machine_tabs)
        nameInput = findViewById(R.id.input_name)
        urlInput = findViewById(R.id.input_url)
        tokenInput = findViewById(R.id.input_token)
        statusText = findViewById(R.id.config_status)
        saveBtn = findViewById(R.id.btn_save)
        removeBtn = findViewById(R.id.btn_remove)
        scanBtn = findViewById(R.id.btn_scan)
        typeToggle = findViewById(R.id.btn_type_toggle)
        manualForm = findViewById(R.id.manual_form)
        val pasteBtn = findViewById<Button>(R.id.btn_paste_link)
        val openPwaBtn = findViewById<Button>(R.id.btn_open_pwa)

        // A phone without a camera has only the typed form.
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            findViewById<View>(R.id.scan_card).visibility = View.GONE
            typeToggle.visibility = View.GONE
            formOpen = true
        }

        editingId = VibeForgeStore.getActive(this)?.id
        showEditing()

        scanBtn.setOnClickListener { scan() }
        typeToggle.setOnClickListener {
            formOpen = !formOpen
            showForm()
        }
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

    /** Folds the typed form away or out, and says on its button which it would do. */
    private fun showForm() {
        manualForm.visibility = if (formOpen) View.VISIBLE else View.GONE
        val paired = VibeForgeStore.getMachines(this).firstOrNull { it.id == editingId }?.paired == true
        typeToggle.text = when {
            formOpen -> "HIDE THE TYPED FORM ▴"
            paired -> "CHANGE NAME OR ADDRESS ▾"
            else -> "TYPE THE ADDRESS AND CODE INSTEAD ▾"
        }
    }

    /** Scan: the camera permission is asked for here, when it is first needed, then the camera opens. */
    private fun scan() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openScanner()
        } else {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    private fun openScanner() {
        try {
            startActivityForResult(Intent(this, ScanActivity::class.java), REQUEST_SCAN)
        } catch (_: Exception) {
            cameraUnavailable()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            openScanner()
        } else {
            cameraRefused()
        }
    }

    private fun cameraRefused() {
        formOpen = true
        showForm()
        // Android stops asking once it has been told no for good: then only the phone's settings turn it on.
        if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            say("Without the camera the widget can't read the QR code. Tap Scan to be asked again, or type the address and pairing code below.", "#FCA311")
        } else {
            say("The camera is turned off for VibeForge Widget, so it can't read the QR code. Turn it on in the phone's Settings → Apps → VibeForge Widget → Permissions → Camera, or type the address and pairing code below.", "#FCA311")
        }
    }

    private fun cameraUnavailable() {
        formOpen = true
        showForm()
        say("Couldn't open the camera (another app may be using it). Tap Scan to try again, or type the address and pairing code below.", "#FF4D6D")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_SCAN) return
        if (resultCode == RESULT_OK) {
            val found = PairingLink.read(data?.getStringExtra(ScanActivity.EXTRA_LINK))
            if (found == null) {
                say("That QR code isn't a VibeForge pairing link. Use the one in Settings → Phone → Show QR code.", "#FF4D6D")
                return
            }
            pairScanned(found)
            return
        }
        when (data?.getStringExtra(ScanActivity.EXTRA_PROBLEM)) {
            ScanActivity.PROBLEM_CAMERA -> cameraUnavailable()
            ScanActivity.PROBLEM_PERMISSION -> cameraRefused()
            else -> {
                // Cancel, which offers typing instead.
                formOpen = true
                showForm()
            }
        }
    }

    /**
     * A scanned link pairs at once. A computer already here at that address is paired again in its
     * place, keeping the name given to it; any other is added. One that still takes the widget's key
     * is left as it is: pairing again would only list the widget twice in Settings → Phone.
     */
    private fun pairScanned(found: PairingLink.Found) {
        val existing = VibeForgeStore.getMachines(this).firstOrNull { VibeForgeStore.normalizeUrl(it.url).lowercase() == found.url }
        val name = if (existing == null || VibeForgeStore.isAutoNamed(this, existing.id)) "" else existing.name
        val host = found.url.removePrefix("https://")
        say("Found ${existing?.name ?: VibeForgeStore.defaultName(found.url)} ($host). Pairing…", "#FCA311")
        if (existing?.paired == true) {
            setBusy(true)
            VibeForgeApi.networkExecutor.execute {
                // A key it no longer takes is let go here (a 401), and then it is paired again below.
                val reachable = VibeForgeApi.refreshMachine(applicationContext, existing, timeoutMs = 8_000)
                val stillPaired = VibeForgeStore.getMachines(applicationContext).firstOrNull { it.id == existing.id }?.paired == true
                runOnUiThread {
                    if (!stillPaired) {
                        startPairing(existing.id, name, found.url, found.code)
                        return@runOnUiThread
                    }
                    setBusy(false)
                    VibeForgeStore.setActive(applicationContext, existing.id)
                    editingId = existing.id
                    statusText.visibility = View.GONE
                    showEditing()
                    VibeForgeWidgetProvider.triggerRefresh(applicationContext)
                    if (reachable) {
                        say("Already paired with ${existing.name}, and it answers: nothing to do. It's on show now.", "#34D399")
                        finishForWidget("Already paired with ${existing.name}.")
                    } else {
                        val err = VibeForgeStore.getCachedDashboardFor(applicationContext, existing.id).error ?: "Offline — check Tailscale"
                        say("Already paired with ${existing.name}, but it can't be reached just now: $err", "#FCA311")
                    }
                }
            }
            return
        }
        startPairing(existing?.id, name, found.url, found.code)
    }

    /** Opened for a widget (placing it, or its ⚙): a computer that works hands it back, saying so in a short toast as it goes. */
    private fun finishForWidget(said: String) {
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
        Toast.makeText(applicationContext, said, Toast.LENGTH_LONG).show()
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        finish()
    }

    private fun setBusy(busy: Boolean) {
        saveBtn.isEnabled = !busy
        scanBtn.isEnabled = !busy
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
                editing != null -> say("Not paired with ${editing.name}. Tap Scan the QR code and point at Settings → Phone → Show QR code on it.", "#FCA311")
            }
        }
        showForm()
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

        say("Pairing with ${typedName.ifEmpty { VibeForgeStore.defaultName(url) }}…", "#FCA311")
        startPairing(editingId, typedName, url, code)
    }

    /**
     * Sends the code to the computer at `url` once (POST /api/pair) and keeps the key it gives back,
     * for the computer with this id (null adds one). Typed or scanned, pairing ends here.
     */
    private fun startPairing(id: String?, typedName: String, url: String, code: String) {
        setBusy(true)
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
            } catch (e: Exception) {
                // Say what actually went wrong too: "couldn't reach" alone hid a DNS failure from a
                // network one from a certificate one.
                val why = listOfNotNull(e.javaClass.simpleName, e.message?.take(160)).joinToString(": ")
                Result.failure(IllegalStateException("Couldn't reach that computer. Is VibeForge running there with Settings → Phone on, and is Tailscale connected on this phone?\n($why)"))
            }
            val machine = outcome.getOrNull()
            val ok = machine != null && VibeForgeApi.refreshMachine(applicationContext, machine, timeoutMs = 8_000)
            VibeForgeWidgetProvider.triggerRefresh(applicationContext)

            runOnUiThread {
                setBusy(false)
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
                    finishForWidget("Paired with ${machine.name}.")
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

    private companion object {
        const val REQUEST_CAMERA = 41
        const val REQUEST_SCAN = 42
    }
}
