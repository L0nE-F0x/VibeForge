package net.vibeforge.widget

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/**
 * The camera, reading the QR code Settings → Phone shows on the computer. It reads on the phone
 * itself (ZXing, no Google Play Services) and nothing it sees leaves the phone. It keeps looking
 * until it sees a VibeForge pairing link (PairingLink) and hands that back; any other QR code is
 * said to be the wrong one and looking goes on. The camera permission is asked for before this
 * opens (WidgetConfigActivity), when Scan is tapped.
 */
class ScanActivity : Activity() {

    private lateinit var scanner: DecoratedBarcodeView
    private var done = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            finishWith(PROBLEM_PERMISSION)
            return
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_scan)

        // Android 15 draws the window under the status and navigation bars: the title and Cancel stay clear of them.
        val top = findViewById<View>(R.id.scan_top)
        val bottom = findViewById<View>(R.id.scan_bottom)
        val pad = (20 * resources.displayMetrics.density).toInt()
        findViewById<View>(R.id.scan_root).setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            top.setPadding(pad, pad + insets.systemWindowInsetTop, pad, pad)
            @Suppress("DEPRECATION")
            bottom.setPadding(pad, pad, pad, pad + insets.systemWindowInsetBottom)
            insets
        }

        scanner = findViewById(R.id.scanner)
        scanner.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
        // The library's own line under the viewfinder gives way to ours, above Cancel.
        scanner.statusView.visibility = View.GONE
        val status = findViewById<TextView>(R.id.scan_status)
        scanner.barcodeView.addStateListener(object : CameraPreview.StateListener {
            override fun previewSized() {}
            override fun previewStarted() {}
            override fun previewStopped() {}
            override fun cameraClosed() {}
            override fun cameraError(error: Exception?) {
                runOnUiThread { finishWith(PROBLEM_CAMERA) }
            }
        })
        scanner.decodeContinuous(BarcodeCallback { result ->
            if (done) return@BarcodeCallback
            val text = result.text.orEmpty()
            if (PairingLink.read(text) != null) {
                done = true
                scanner.pause()
                setResult(RESULT_OK, Intent().putExtra(EXTRA_LINK, text))
                finish()
            } else {
                status.setTextColor(Color.parseColor("#FCA311"))
                status.text = getString(R.string.scan_wrong_code)
            }
        })

        findViewById<Button>(R.id.btn_scan_cancel).setOnClickListener {
            done = true
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::scanner.isInitialized && !done) scanner.resume()
    }

    override fun onPause() {
        super.onPause()
        if (::scanner.isInitialized) scanner.pause()
    }

    private fun finishWith(problem: String) {
        if (done) return
        done = true
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_PROBLEM, problem))
        finish()
    }

    companion object {
        /** The pairing link read (RESULT_OK). */
        const val EXTRA_LINK = "net.vibeforge.widget.SCANNED_LINK"

        /** Why nothing was read (RESULT_CANCELED): PROBLEM_CAMERA or PROBLEM_PERMISSION; absent when Cancel was tapped. */
        const val EXTRA_PROBLEM = "net.vibeforge.widget.SCAN_PROBLEM"
        const val PROBLEM_CAMERA = "camera"
        const val PROBLEM_PERMISSION = "permission"
    }
}
