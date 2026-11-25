package net.vibeforge.widget

import java.net.URI

/**
 * The pairing link Settings → Phone draws as a QR code (src/ui/components/CompanionCard.tsx):
 * `https://<computer>.<tailnet>.ts.net[:port]/#pair=vf_<32 hex>`. A scan is only ever sent anywhere
 * when it reads as exactly that: an https address on a Tailscale name, nothing but "/" after it, and
 * the code after the `#`. Anything else (a web page, a Wi-Fi code, a link with a path or a query)
 * is not a VibeForge pairing link, and nothing is sent.
 *
 * Plain Kotlin and java.net.URI, no Android classes, so the JVM unit tests read it as the phone does.
 */
object PairingLink {

    /** What a scanned link holds: the computer's address (`https://host[:port]`) and its pairing code. */
    data class Found(val url: String, val code: String)

    private val CODE = Regex("^(?:pair=)?(vf_[0-9a-f]{32})$")
    private val LABEL = Regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")

    /** The address and code in a scanned text, or null when it isn't a VibeForge pairing link. */
    fun read(text: String?): Found? {
        val raw = text?.trim().orEmpty()
        if (raw.isEmpty() || raw.length > 512 || raw.any { it.isWhitespace() }) return null
        if (!raw.startsWith("https://", ignoreCase = true)) return null
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return null
        }
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        if (uri.rawUserInfo != null || uri.rawQuery != null) return null
        val path = uri.rawPath.orEmpty()
        if (path.isNotEmpty() && path != "/") return null
        val code = CODE.find(uri.rawFragment.orEmpty())?.groupValues?.get(1) ?: return null
        val host = uri.host?.lowercase()?.trimEnd('.') ?: return null
        if (!isTailscaleName(host)) return null
        val port = uri.port
        if (port == 0 || port > 65535) return null
        val url = if (port < 0 || port == 443) "https://$host" else "https://$host:$port"
        return Found(url, code)
    }

    /** `<computer>.<tailnet>.ts.net`: the only kind of address Settings → Phone gives (Tailscale's own names). */
    private fun isTailscaleName(host: String): Boolean {
        val labels = host.split('.')
        if (labels.size < 4 || labels.takeLast(2) != listOf("ts", "net")) return false
        return labels.all { it.length in 1..63 && LABEL.matches(it) }
    }
}
