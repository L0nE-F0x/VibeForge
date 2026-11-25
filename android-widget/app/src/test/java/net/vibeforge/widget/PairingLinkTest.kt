package net.vibeforge.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingLinkTest {

    private val code = "vf_0123456789abcdef0123456789abcdef"

    @Test
    fun readsTheLinkSettingsPhoneDraws() {
        // src/ui/components/CompanionCard.tsx: `${address}/#pair=${token}`
        assertEquals(
            PairingLink.Found("https://desktop.tail1234.ts.net", code),
            PairingLink.read("https://desktop.tail1234.ts.net/#pair=$code"),
        )
    }

    @Test
    fun takesTheShortFormAndTheEdgesOfAScan() {
        val found = PairingLink.Found("https://desktop.tail1234.ts.net", code)
        assertEquals(found, PairingLink.read("https://desktop.tail1234.ts.net/#$code"))
        assertEquals(found, PairingLink.read("https://desktop.tail1234.ts.net#pair=$code"))
        assertEquals(found, PairingLink.read("  https://Desktop.Tail1234.TS.NET/#pair=$code\n"))
        assertEquals(found, PairingLink.read("HTTPS://desktop.tail1234.ts.net/#pair=$code"))
        assertEquals(found, PairingLink.read("https://desktop.tail1234.ts.net:443/#pair=$code"))
    }

    @Test
    fun keepsAPortOtherThan443() {
        assertEquals(
            PairingLink.Found("https://desktop.tail1234.ts.net:8443", code),
            PairingLink.read("https://desktop.tail1234.ts.net:8443/#pair=$code"),
        )
    }

    @Test
    fun refusesWhatIsNotAPairingLink() {
        val refused = listOf(
            null,
            "",
            code,
            "WIFI:S:home;T:WPA;P:secret;;",
            "https://example.com/",
            "https://desktop.tail1234.ts.net/",
            "https://desktop.tail1234.ts.net/#pair=",
            "https://desktop.tail1234.ts.net/#pair=vf_short",
            "https://desktop.tail1234.ts.net/#pair=${code}x",
            "https://desktop.tail1234.ts.net/#pair=VF_0123456789ABCDEF0123456789ABCDEF",
            "https://desktop.tail1234.ts.net/#other=$code",
        )
        for (text in refused) assertNull(text, PairingLink.read(text))
    }

    @Test
    fun sendsNothingToAnAddressThatIsNotAComputerOnTheTailnet() {
        val refused = listOf(
            // Not https: Settings → Phone only gives https addresses.
            "http://desktop.tail1234.ts.net/#pair=$code",
            "ftp://desktop.tail1234.ts.net/#pair=$code",
            "intent://desktop.tail1234.ts.net/#pair=$code",
            // Not a Tailscale name.
            "https://example.com/#pair=$code",
            "https://evil.example/#pair=$code",
            "https://ts.net/#pair=$code",
            "https://tail1234.ts.net/#pair=$code",
            "https://desktop.tail1234.ts.net.evil.com/#pair=$code",
            "https://127.0.0.1/#pair=$code",
            "https://192.168.1.10/#pair=$code",
            // More than an address.
            "https://user@desktop.tail1234.ts.net/#pair=$code",
            "https://user:pw@desktop.tail1234.ts.net/#pair=$code",
            "https://desktop.tail1234.ts.net/path#pair=$code",
            "https://desktop.tail1234.ts.net/?q=1#pair=$code",
            "https://desktop.tail1234.ts.net:0/#pair=$code",
            "https://desktop.tail1234.ts.net:99999/#pair=$code",
            "https://desk top.tail1234.ts.net/#pair=$code",
            "https://desk_top.tail1234.ts.net/#pair=$code",
            "https://-desktop.tail1234.ts.net/#pair=$code",
            "https://desktop.tail1234.ts.net/#pair=$code more",
            "https://" + "a".repeat(600) + ".tail1234.ts.net/#pair=$code",
        )
        for (text in refused) assertNull(text, PairingLink.read(text))
    }
}
