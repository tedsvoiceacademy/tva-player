package com.tedsvoiceacademy.player;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Getting at the person's own music, wherever they keep it.
 *
 * ANDROID'S OWN PICKER IS THE WHOLE POINT. Ted: "I can use any file on the
 * phone, in OneDrive, in any of my Google Drives, and so on. I want the same
 * with this app." ACTION_OPEN_DOCUMENT is exactly that — every provider
 * installed on the phone appears in one list, and the app never needs an account,
 * a token or a permission for any of them. Asking for READ_EXTERNAL_STORAGE and
 * walking the filesystem, which is the obvious thing to write, reaches the local
 * Music folder and NOTHING in Drive or OneDrive.
 *
 * What comes back is a content:// URI rather than a path. It is held with
 * takePersistableUriPermission so the song is still there next week, and it is
 * read through the provider that issued it — which is what makes a file in Drive
 * behave like a file on the phone.
 *
 * FOLDERS ARE NOT UNIVERSAL, and the app says so rather than pretending. Local
 * storage and some providers support picking a whole folder; Google Drive's
 * provider does not offer one at all. So a folder is offered where the phone
 * offers it, and picking files works everywhere.
 */
@CapacitorPlugin(name = "Files")
public class Files extends Plugin {

    private static final String[] AUDIO_MIME = {
        "audio/*", "application/ogg", "application/x-ogg"
    };

    @PluginMethod
    public void pickSongs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, AUDIO_MIME);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "songsPicked");
    }

    @ActivityCallback
    private void songsPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSArray songs = new JSArray();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("songs", songs));
            return;
        }
        Intent data = result.getData();
        List<Uri> chosen = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                chosen.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            chosen.add(data.getData());
        }
        for (Uri uri : chosen) {
            keep(uri);
            songs.put(describe(uri));
        }
        call.resolve(new JSObject().put("songs", songs));
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            call.resolve(new JSObject().put("folder", JSObject.NULL));
            return;
        }
        Uri tree = result.getData().getData();
        keep(tree);
        JSObject folder = new JSObject();
        folder.put("uri", tree.toString());
        folder.put("name", treeName(tree));
        call.resolve(new JSObject().put("folder", folder));
    }

    /** Every playable file under a folder that was picked, however deep. */
    @PluginMethod
    public void scanFolder(PluginCall call) {
        String treeUri = call.getString("uri", "");
        JSArray songs = new JSArray();
        if (treeUri == null || treeUri.isEmpty()) {
            call.resolve(new JSObject().put("songs", songs));
            return;
        }
        Uri tree = Uri.parse(treeUri);
        String rootId = DocumentsContract.getTreeDocumentId(tree);
        walk(tree, rootId, songs, 0);
        call.resolve(new JSObject().put("songs", songs));
    }

    private void walk(Uri tree, String documentId, JSArray into, int depth) {
        /* Six levels. A person's music folder is nested; their whole phone is
           not, and a provider that loops would otherwise never stop. */
        if (depth > 6 || into.length() >= 2000) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        try (Cursor cursor = getContext().getContentResolver().query(children, new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        }, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    walk(tree, id, into, depth + 1);
                } else if (playable(name, mime)) {
                    Uri child = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                    JSObject song = new JSObject();
                    song.put("uri", child.toString());
                    song.put("name", name);
                    song.put("size", size);
                    into.put(song);
                }
            }
        } catch (Exception ignored) {
            /* A provider that has gone away — an unplugged SD card, an account
               signed out. The folders that still answer are still listed. */
        }
    }

    private boolean playable(String name, String mime) {
        if (mime != null && mime.startsWith("audio/")) return true;
        if (name == null) return false;
        String lower = name.toLowerCase();
        for (String ext : new String[] {
            ".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg", ".oga", ".opus", ".wma", ".aiff", ".aif"
        }) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }

    /** Name and size for a URI the app was handed earlier. */
    @PluginMethod
    public void describeUri(PluginCall call) {
        String uri = call.getString("uri", "");
        if (uri == null || uri.isEmpty()) { call.reject("No file was named."); return; }
        call.resolve(describe(Uri.parse(uri)));
    }

    /**
     * Part of a file, as base64.
     *
     * The player streams songs through the WebView's own request path, but the
     * export code reads a take's bytes in slices — so this exists for that, and
     * for reading a WAV header without opening the whole file.
     */
    @PluginMethod
    public void readRange(PluginCall call) {
        String uri = call.getString("uri", "");
        long start = call.getLong("start", 0L);
        int length = call.getInt("length", 65536);
        if (uri == null || uri.isEmpty()) { call.reject("No file was named."); return; }
        try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
            if (in == null) { call.reject("That file could not be opened."); return; }
            long skipped = 0;
            while (skipped < start) {
                long n = in.skip(start - skipped);
                if (n <= 0) break;
                skipped += n;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int wanted = length;
            while (wanted > 0) {
                int read = in.read(buffer, 0, Math.min(buffer.length, wanted));
                if (read < 0) break;
                out.write(buffer, 0, read);
                wanted -= read;
            }
            JSObject answer = new JSObject();
            answer.put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(answer);
        } catch (Exception err) {
            call.reject("That file could not be read. " + err.getMessage());
        }
    }

    /** Where to put a copy the person is saving out. Android's own Save box. */
    @PluginMethod
    public void createDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "Take"));
        startActivityForResult(call, intent, "documentCreated");
    }

    @ActivityCallback
    private void documentCreated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject answer = new JSObject();
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null
            && result.getData().getData() != null) {
            answer.put("uri", result.getData().getData().toString());
        } else {
            answer.put("uri", JSObject.NULL);
        }
        call.resolve(answer);
    }

    /**
     * Add bytes to a document the person chose.
     *
     * "wa" rather than "w": a forty-five minute lesson is written in pieces, and
     * re-opening in "w" for each piece would truncate the file every time —
     * leaving a saved take that is only ever as long as its last slice.
     */
    @PluginMethod
    public void appendToDocument(PluginCall call) {
        String uri = call.getString("uri", "");
        String base64 = call.getString("base64", "");
        if (uri == null || uri.isEmpty()) { call.reject("No file was named."); return; }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(Uri.parse(uri), "wa")) {
            if (out == null) { call.reject("That file could not be written to."); return; }
            out.write(Base64.decode(base64, Base64.NO_WRAP));
            call.resolve();
        } catch (Exception err) {
            call.reject("That file could not be written. " + err.getMessage());
        }
    }

    @PluginMethod
    public void truncateDocument(PluginCall call) {
        String uri = call.getString("uri", "");
        if (uri == null || uri.isEmpty()) { call.reject("No file was named."); return; }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(Uri.parse(uri), "wt")) {
            if (out != null) out.flush();
            call.resolve();
        } catch (Exception err) {
            call.reject("That file could not be emptied. " + err.getMessage());
        }
    }

    @PluginMethod
    public void deleteDocument(PluginCall call) {
        String uri = call.getString("uri", "");
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), Uri.parse(uri));
        } catch (Exception ignored) { /* already gone */ }
        call.resolve();
    }

    /* Hold on to it, so a song picked today still opens next week. The system
       caps how many a single app may keep, so the oldest is let go rather than
       the newest being silently refused. */
    private void keep(Uri uri) {
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            /* A provider that does not offer persistable permission. The song
               still opens for as long as the app is running. */
        }
    }

    private JSObject describe(Uri uri) {
        JSObject song = new JSObject();
        song.put("uri", uri.toString());
        song.put("name", uri.getLastPathSegment());
        song.put("size", 0);
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameAt = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                int sizeAt = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                if (nameAt >= 0 && !cursor.isNull(nameAt)) song.put("name", cursor.getString(nameAt));
                if (sizeAt >= 0 && !cursor.isNull(sizeAt)) song.put("size", cursor.getLong(sizeAt));
            }
        } catch (Exception ignored) { /* the name falls back to the URI's tail */ }
        return song;
    }

    private String treeName(Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        if (id == null) return "Folder";
        int colon = id.lastIndexOf(':');
        String tail = colon >= 0 ? id.substring(colon + 1) : id;
        if (tail.isEmpty()) return "Whole device";
        int slash = tail.lastIndexOf('/');
        return slash >= 0 ? tail.substring(slash + 1) : tail;
    }

    /* ---- the folder shared with the computer ------------------------------
     *
     * The Windows app keeps a song's loops, named parts and notes in one small
     * file per song, in a folder inside OneDrive — and it prints that folder's
     * path under Set-up. Pointed at the same folder through Android's picker,
     * the phone reads and writes the same files, and a part marked on the
     * desktop is there on the phone without anything being invented in between.
     *
     * ONLY THOSE FILES. What each machine knows about ITSELF — which folders it
     * has been pointed at, which microphones it has, which skin it wears — stays
     * on that machine. Sharing a Windows folder list with a phone would put
     * paths it cannot read into a list it cannot use.
     *
     * A provider that refuses to give a writable folder says so here rather
     * than appearing to work: not every one offers a folder at all, and Google
     * Drive's does not.
     */

    /** One named file inside a picked folder — "settings.json", "songs/ab12.json". */
    @PluginMethod
    public void readInTree(PluginCall call) {
        String treeUri = call.getString("tree", "");
        String wanted = call.getString("path", "");
        try {
            Uri file = findInTree(Uri.parse(treeUri), wanted, false);
            if (file == null) { call.resolve(new JSObject().put("base64", JSObject.NULL)); return; }
            try (InputStream in = getContext().getContentResolver().openInputStream(file)) {
                if (in == null) { call.resolve(new JSObject().put("base64", JSObject.NULL)); return; }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int read = in.read(buffer); read >= 0; read = in.read(buffer)) out.write(buffer, 0, read);
                call.resolve(new JSObject().put("base64",
                    Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)));
            }
        } catch (Exception err) {
            call.resolve(new JSObject().put("base64", JSObject.NULL).put("error", String.valueOf(err.getMessage())));
        }
    }

    @PluginMethod
    public void writeInTree(PluginCall call) {
        String treeUri = call.getString("tree", "");
        String wanted = call.getString("path", "");
        String base64 = call.getString("base64", "");
        try {
            Uri file = findInTree(Uri.parse(treeUri), wanted, true);
            if (file == null) { call.resolve(new JSObject().put("written", false)
                .put("error", "That folder would not take a new file.")); return; }
            /* "wt" truncates. A settings file written over a longer one without
               it keeps the tail of the old one and comes back as broken JSON. */
            try (OutputStream out = getContext().getContentResolver().openOutputStream(file, "wt")) {
                if (out == null) { call.resolve(new JSObject().put("written", false)
                    .put("error", "That folder is read-only.")); return; }
                out.write(Base64.decode(base64, Base64.NO_WRAP));
            }
            call.resolve(new JSObject().put("written", true));
        } catch (Exception err) {
            call.resolve(new JSObject().put("written", false).put("error", String.valueOf(err.getMessage())));
        }
    }

    /** Can this folder actually be written to? Asked once, when it is chosen. */
    @PluginMethod
    public void canWriteTree(PluginCall call) {
        String treeUri = call.getString("tree", "");
        try {
            Uri probe = findInTree(Uri.parse(treeUri), "tva-write-test.tmp", true);
            if (probe == null) { call.resolve(new JSObject().put("writable", false)); return; }
            try (OutputStream out = getContext().getContentResolver().openOutputStream(probe, "wt")) {
                if (out == null) { call.resolve(new JSObject().put("writable", false)); return; }
                out.write(new byte[] { 'o', 'k' });
            }
            DocumentsContract.deleteDocument(getContext().getContentResolver(), probe);
            call.resolve(new JSObject().put("writable", true));
        } catch (Exception err) {
            call.resolve(new JSObject().put("writable", false).put("error", String.valueOf(err.getMessage())));
        }
    }

    /* Walk a path inside a picked folder, making the folders on the way when
       asked to. SAF has no "open this path" — every step is a listing. */
    private Uri findInTree(Uri tree, String wanted, boolean create) throws Exception {
        String[] parts = wanted.split("/");
        String documentId = DocumentsContract.getTreeDocumentId(tree);
        for (int i = 0; i < parts.length; i++) {
            if (parts[i].isEmpty()) continue;
            boolean last = i == parts.length - 1;
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, documentId);
            String found = childIdNamed(tree, documentId, parts[i]);
            if (found != null) {
                if (last) return DocumentsContract.buildDocumentUriUsingTree(tree, found);
                documentId = found;
                continue;
            }
            if (!create) return null;
            Uri made = DocumentsContract.createDocument(getContext().getContentResolver(), parent,
                last ? "application/json" : DocumentsContract.Document.MIME_TYPE_DIR, parts[i]);
            if (made == null) return null;
            if (last) return made;
            documentId = DocumentsContract.getDocumentId(made);
        }
        return null;
    }

    private String childIdNamed(Uri tree, String parentId, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        try (Cursor cursor = getContext().getContentResolver().query(children, new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        }, null, null, null)) {
            if (cursor == null) return null;
            while (cursor.moveToNext()) {
                if (name.equals(cursor.getString(1))) return cursor.getString(0);
            }
        } catch (Exception ignored) { /* a provider that has gone away */ }
        return null;
    }
}
