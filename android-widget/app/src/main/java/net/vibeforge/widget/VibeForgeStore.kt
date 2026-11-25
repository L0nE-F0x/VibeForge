package net.vibeforge.widget

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * One computer the widget can show: where its phone page is, and the key it gave this widget when it
 * paired (empty until it has). The key is kept sealed (KeyVault); the pairing code is never kept.
 */
data class Machine(
    val id: String,
    val name: String,
    val url: String,
    val key: String,
) {
    val paired: Boolean
        get() = key.isNotEmpty()
}

object VibeForgeStore {
    private const val PREFS = "vibeforge_widget_prefs"

    // The one computer the widget kept before it could hold several. Its address is carried over; the
    // pairing code it kept beside it is dropped (2.1.0 pairs for a key of its own instead).
    private const val KEY_URL = "server_url"
    private const val KEY_TOKEN = "pairing_token"
    private const val LEGACY_ID = "m1"

    private const val KEY_MACHINES = "machines_json"
    private const val KEY_ACTIVE = "active_machine"

    // What each computer last said, kept apart (the key ends in the computer's id), so switching
    // shows that computer's own numbers at once instead of the other one's.
    private const val KEY_DESK_JSON = "cached_desk_json"
    private const val KEY_PLANS_JSON = "cached_plans_json"
    private const val KEY_ORCH_JSON = "cached_orch_json"
    private const val KEY_ETAG_DESK = "etag_desk"
    private const val KEY_ETAG_PLANS = "etag_plans"
    private const val KEY_ETAG_ORCH = "etag_orch"
    private const val KEY_UPDATED_AT = "updated_at_ms"
    private const val KEY_LAST_ERROR = "last_error"
    private const val KEY_AUTO_NAMED = "auto_named"
    private const val NO_MACHINE = "none"

    private val BARE_TOKEN_REGEX = Regex("^vf_[0-9a-f]{32}$")
    private val HASH_TOKEN_REGEX = Regex("#(?:pair=)?(vf_[0-9a-f]{32})$")

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun keyFor(base: String, machineId: String): String = "$base:$machineId"

    /** "laptop" of https://laptop.tail1234.ts.net: what a computer is called until it is given a name. */
    fun defaultName(url: String): String {
        val host = try {
            Uri.parse(url).host.orEmpty()
        } catch (_: Exception) {
            ""
        }
        return host.substringBefore('.').ifEmpty { "Computer" }
    }

    /** An address as typed: no trailing slash, and https when no scheme was given. */
    fun normalizeUrl(raw: String): String {
        val trimmed = raw.trim().trimEnd('/')
        if (trimmed.isEmpty()) return ""
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "https://$trimmed"
    }

    private fun hostOf(url: String): String = try {
        Uri.parse(url).host.orEmpty().lowercase()
    } catch (_: Exception) {
        ""
    }

    /**
     * A computer's address as someone typed it, made whole: https when no scheme was given, and a
     * bare name ("laptop") completed with the tailnet of a computer already here. Null for what
     * can't be an address at all: a command pasted by mistake, anything with a space, no host.
     */
    fun cleanAddress(context: Context, raw: String): String? {
        var text = raw.trim().trimEnd('/')
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        if (!text.startsWith("http://") && !text.startsWith("https://")) {
            if (!text.contains('.')) {
                val tailnet = getMachines(context)
                    .map { hostOf(it.url) }
                    .firstOrNull { it.endsWith(".ts.net") }
                    ?.substringAfter('.')
                if (tailnet != null) {
                    val name = text.substringBefore(':')
                    text = "$name.$tailnet${text.substring(name.length)}"
                }
            }
            text = "https://$text"
        }
        return try {
            val parsed = Uri.parse(text)
            val host = parsed.host.orEmpty().lowercase()
            if (!host.contains('.')) return null
            val scheme = parsed.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            val authority = parsed.encodedAuthority.orEmpty()
            if (authority.isEmpty()) null else "$scheme://$authority"
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The link Settings → Phone shows carries the pairing code after "#pair=" (or "#vf_...").
     * Pasted whole, it is split into the address and the code.
     */
    fun splitLink(raw: String): Pair<String, String> {
        val trimmed = raw.trim()
        val match = HASH_TOKEN_REGEX.find(trimmed)
        if (match != null) {
            return trimmed.substring(0, match.range.first) to match.groupValues[1]
        }
        val at = trimmed.indexOf("#pair=")
        if (at >= 0) return trimmed.substring(0, at) to trimmed.substring(at + "#pair=".length).trim()
        return trimmed.substringBefore('#') to ""
    }

    /**
     * Parses a clipboard snippet that might be a full Settings → Phone link, a bare pairing code,
     * or a computer address. Returns (cleanedUrlOrNull, pairingCodeOrEmpty, recognizedAnything).
     */
    fun extractClipboardPairing(context: Context, raw: String): Triple<String?, String, Boolean> {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return Triple(null, "", false)
        if (BARE_TOKEN_REGEX.matches(trimmed)) {
            return Triple(null, trimmed, true)
        }
        val (address, linkCode) = splitLink(trimmed)
        val cleanUrl = cleanAddress(context, address)
        return Triple(cleanUrl, linkCode, cleanUrl != null || linkCode.isNotEmpty())
    }

    /** A computer as kept: its key still sealed. */
    private data class Kept(val id: String, val name: String, val url: String, val sealedKey: String)

    private fun readKept(context: Context): List<Kept> {
        val p = prefs(context)
        val saved = p.getString(KEY_MACHINES, null)
        if (saved == null) {
            // Nothing saved as a list yet: the one computer from before, if there was one.
            val url = normalizeUrl(p.getString(KEY_URL, null).orEmpty())
            val legacy = if (url.isEmpty()) emptyList() else listOf(Kept(LEGACY_ID, defaultName(url), url, ""))
            if (p.contains(KEY_URL) || p.contains(KEY_TOKEN)) {
                writeKept(context, legacy)
                p.edit().remove(KEY_URL).remove(KEY_TOKEN).apply()
            }
            return legacy
        }
        val out = mutableListOf<Kept>()
        var hadCode = false
        try {
            val array = JSONArray(saved)
            for (i in 0 until array.length()) {
                val o = array.optJSONObject(i) ?: continue
                val id = o.optString("id")
                val url = o.optString("url")
                if (id.isEmpty() || url.isEmpty()) continue
                // 2.0.0 kept the pairing code itself here, in the clear. It is dropped, not used: that
                // computer is paired again, for a key of its own.
                if (o.has("token")) hadCode = true
                out.add(Kept(id, o.optString("name").ifEmpty { defaultName(url) }, url, o.optString("sealedKey")))
            }
        } catch (_: Exception) {
        }
        if (hadCode) writeKept(context, out)
        return out
    }

    private fun writeKept(context: Context, machines: List<Kept>) {
        val array = JSONArray()
        for (m in machines) {
            val o = JSONObject().put("id", m.id).put("name", m.name).put("url", m.url)
            if (m.sealedKey.isNotEmpty()) o.put("sealedKey", m.sealedKey)
            array.put(o)
        }
        prefs(context).edit().putString(KEY_MACHINES, array.toString()).apply()
    }

    fun getMachines(context: Context): List<Machine> =
        readKept(context).map { Machine(it.id, it.name, it.url, if (it.sealedKey.isEmpty()) "" else KeyVault.open(it.sealedKey).orEmpty()) }

    /** The computer on show: the one last chosen while it is still there, else the first. */
    fun getActive(context: Context): Machine? {
        val machines = getMachines(context)
        val id = prefs(context).getString(KEY_ACTIVE, null)
        return machines.firstOrNull { it.id == id } ?: machines.firstOrNull()
    }

    fun setActive(context: Context, id: String) {
        prefs(context).edit().putString(KEY_ACTIVE, id).apply()
    }

    /**
     * Adds a computer (id null), or changes the one with this id, and returns it as kept. `key` is
     * the one it just gave this widget; null keeps the key it already has. Null back when the key
     * could not be sealed: nothing is kept then.
     */
    fun saveMachine(context: Context, id: String?, name: String, url: String, key: String?, computerName: String = ""): Machine? {
        val cleanUrl = normalizeUrl(url)
        val machines = readKept(context).toMutableList()
        val typedName = name.trim()
        val newId = id ?: "m${System.currentTimeMillis()}"
        val at = machines.indexOfFirst { it.id == newId }
        val sealed = when {
            key == null -> if (at >= 0) machines[at].sealedKey else ""
            key.isEmpty() -> ""
            else -> KeyVault.seal(key) ?: return null
        }
        val kept = Kept(
            id = newId,
            name = typedName.ifEmpty { computerName.trim().ifEmpty { defaultName(cleanUrl) } },
            url = cleanUrl,
            sealedKey = sealed,
        )
        if (at >= 0) machines[at] = kept else machines.add(kept)
        writeKept(context, machines)
        prefs(context).edit().putBoolean(keyFor(KEY_AUTO_NAMED, kept.id), typedName.isEmpty()).apply()
        return getMachines(context).firstOrNull { it.id == kept.id }
    }

    /**
     * The computer no longer takes this widget's key (removed in Settings → Phone): it is let go, with
     * what that computer last said (it would show sessions as running that nobody can see now), and
     * the widget asks to pair again.
     */
    fun forgetKey(context: Context, id: String) {
        val machines = readKept(context)
        if (machines.none { it.id == id && it.sealedKey.isNotEmpty() }) return
        writeKept(context, machines.map { if (it.id == id) it.copy(sealedKey = "") else it })
        forgetShown(context, id).apply()
    }

    private fun forgetShown(context: Context, id: String): SharedPreferences.Editor =
        prefs(context).edit()
            .remove(keyFor(KEY_DESK_JSON, id))
            .remove(keyFor(KEY_PLANS_JSON, id))
            .remove(keyFor(KEY_ORCH_JSON, id))
            .remove(keyFor(KEY_ETAG_DESK, id))
            .remove(keyFor(KEY_ETAG_PLANS, id))
            .remove(keyFor(KEY_ETAG_ORCH, id))
            .remove(keyFor(KEY_UPDATED_AT, id))

    /** Updates the machine's name from `/api/desk.computer` when the user didn't pin a custom name. */
    fun maybeUpdateComputerName(context: Context, machineId: String, computerName: String) {
        val clean = computerName.trim()
        if (clean.isEmpty()) return
        val machines = readKept(context).toMutableList()
        val at = machines.indexOfFirst { it.id == machineId }
        if (at < 0) return
        val current = machines[at]
        val autoNamed = prefs(context).getBoolean(keyFor(KEY_AUTO_NAMED, machineId), false) ||
            current.name == defaultName(current.url)
        if (!autoNamed || current.name == clean) return
        machines[at] = current.copy(name = clean)
        writeKept(context, machines)
    }

    /** Takes a computer off the widget, with what it last said. */
    fun removeMachine(context: Context, id: String) {
        writeKept(context, readKept(context).filter { it.id != id })
        forgetShown(context, id)
            .remove(keyFor(KEY_LAST_ERROR, id))
            .remove(keyFor(KEY_AUTO_NAMED, id))
            .apply()
    }

    fun getUrl(context: Context): String = getActive(context)?.url.orEmpty()

    fun getEtag(context: Context, machineId: String, kind: String): String? {
        val key = when (kind) {
            "desk" -> KEY_ETAG_DESK
            "plans" -> KEY_ETAG_PLANS
            "orch" -> KEY_ETAG_ORCH
            else -> return null
        }
        return prefs(context).getString(keyFor(key, machineId), null)
    }

    /**
     * Saves fresh JSON payloads and optional ETags. Passing `null` for a JSON payload preserves
     * whatever was previously cached (e.g. on HTTP 304 Not Modified).
     */
    fun saveSnapshot(
        context: Context,
        machineId: String,
        deskJson: String?,
        plansJson: String?,
        orchJson: String? = null,
        deskEtag: String? = null,
        plansEtag: String? = null,
        orchEtag: String? = null,
    ) {
        val editor = prefs(context).edit()
        if (deskJson != null) editor.putString(keyFor(KEY_DESK_JSON, machineId), deskJson)
        if (plansJson != null) editor.putString(keyFor(KEY_PLANS_JSON, machineId), plansJson)
        if (orchJson != null) editor.putString(keyFor(KEY_ORCH_JSON, machineId), orchJson)
        if (deskEtag != null) editor.putString(keyFor(KEY_ETAG_DESK, machineId), deskEtag)
        if (plansEtag != null) editor.putString(keyFor(KEY_ETAG_PLANS, machineId), plansEtag)
        if (orchEtag != null) editor.putString(keyFor(KEY_ETAG_ORCH, machineId), orchEtag)
        editor.putLong(keyFor(KEY_UPDATED_AT, machineId), System.currentTimeMillis())
        editor.remove(keyFor(KEY_LAST_ERROR, machineId))
        editor.apply()
    }

    /** `machineId` null: there is no computer yet, and the widget says to set one up. */
    fun saveError(context: Context, machineId: String?, error: String) {
        prefs(context).edit().putString(keyFor(KEY_LAST_ERROR, machineId ?: NO_MACHINE), error).apply()
    }

    /** What the computer on show last said. */
    fun getCachedDashboard(context: Context): WidgetDashboard =
        getCachedDashboardFor(context, getActive(context)?.id ?: NO_MACHINE)

    /** What a specific saved computer last said (used for status dots on computer chips). */
    fun getCachedDashboardFor(context: Context, machineId: String): WidgetDashboard {
        val p = prefs(context)
        return VibeForgeApi.parseDashboard(
            deskJsonStr = p.getString(keyFor(KEY_DESK_JSON, machineId), null),
            plansJsonStr = p.getString(keyFor(KEY_PLANS_JSON, machineId), null),
            orchJsonStr = p.getString(keyFor(KEY_ORCH_JSON, machineId), null),
            updatedAtMs = p.getLong(keyFor(KEY_UPDATED_AT, machineId), 0L),
            error = p.getString(keyFor(KEY_LAST_ERROR, machineId), null),
        )
    }
}
