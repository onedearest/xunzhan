package local.xunzhan.phone;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.TextView;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int attempts = 0;
    private WebView desk;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        desk = findViewById(R.id.desk);
        status = findViewById(R.id.status);
        WebSettings settings = desk.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        desk.setWebViewClient(new android.webkit.WebViewClient());
        handler.postDelayed(this::probe, 300);
    }

    private void probe() {
        attempts += 1;
        new Thread(() -> {
            boolean ready = ping();
            handler.post(() -> {
                if (ready) {
                    status.setVisibility(android.view.View.GONE);
                    desk.loadUrl("http://127.0.0.1:43731/");
                    return;
                }
                if (attempts > 40) {
                    status.setText("讯栈没有打开。退出后重新进入再试一次。");
                    return;
                }
                handler.postDelayed(this::probe, 400);
            });
        }).start();
    }

    private boolean ping() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("http://127.0.0.1:43731/api/bootstrap").openConnection();
            connection.setConnectTimeout(800);
            connection.setReadTimeout(800);
            connection.connect();
            return connection.getResponseCode() == 200;
        } catch (IOException error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @Override
    public void onBackPressed() {
        if (desk != null && desk.canGoBack()) {
            desk.goBack();
            return;
        }
        super.onBackPressed();
    }
}
