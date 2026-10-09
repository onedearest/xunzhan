package local.xunzhan.phone;

import android.app.Application;
import android.content.res.AssetManager;
import android.system.Os;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class DeskApp extends Application {
    private static boolean nodeStarted = false;

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    public native int startNodeWithArguments(String[] arguments);

    @Override
    public void onCreate() {
        super.onCreate();
        if (nodeStarted) return;
        nodeStarted = true;
        new Thread(this::bootNode, "xunzhan-node").start();
    }

    private void bootNode() {
        try {
            File project = new File(getFilesDir(), "nodejs-project");
            String bundled = readAsset("nodejs-project/VERSION").trim();
            File marker = new File(project, "VERSION");
            String installed = marker.isFile() ? readFile(marker).trim() : "";
            if (!bundled.equals(installed)) {
                deleteRecursively(project);
                copyAsset("nodejs-project", project);
            }
            File data = new File(getFilesDir(), "data");
            if (!data.isDirectory() && !data.mkdirs()) {
                throw new IOException("建不起数据目录");
            }
            Os.setenv("XUNZHAN_DATA", data.getAbsolutePath(), true);
            Os.setenv("XUNZHAN_UI", new File(project, "ui").getAbsolutePath(), true);
            Os.setenv("XUNZHAN_PORT", "43731", true);
            startNodeWithArguments(new String[]{"node", new File(project, "main.js").getAbsolutePath()});
        } catch (Exception error) {
            android.util.Log.e("Xunzhan", "讯栈服务没有起来", error);
        }
    }

    private String readAsset(String path) throws IOException {
        try (InputStream input = getAssets().open(path)) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String readFile(File file) throws IOException {
        try (InputStream input = new java.io.FileInputStream(file)) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private void copyAsset(String assetPath, File dest) throws IOException {
        AssetManager assets = getAssets();
        String[] children = assets.list(assetPath);
        if (children != null && children.length > 0) {
            if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("建不起 " + dest);
            for (String child : children) {
                copyAsset(assetPath + "/" + child, new File(dest, child));
            }
            return;
        }
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("建不起 " + parent);
        }
        try (InputStream input = assets.open(assetPath);
             FileOutputStream output = new FileOutputStream(dest)) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }
}
