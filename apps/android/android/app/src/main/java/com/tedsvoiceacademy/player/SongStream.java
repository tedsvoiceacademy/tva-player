package com.tedsvoiceacademy.player;

import android.content.ContentResolver;
import android.content.res.AssetFileDescriptor;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Handing a song to the audio element, from wherever it actually lives.
 *
 * A content:// URI cannot be put in an <audio src>, and a song in Google Drive
 * has no path at all — so the page asks for https://localhost/_song/<id> and
 * this answers it out of the provider that issued the URI. It is the same idea
 * as the app:// protocol the Windows app serves songs through, and it exists for
 * the same reason: ONE door, and the page cannot name a file the app was not
 * already given.
 *
 * RANGE IS THE PART THAT MATTERS, and it is not a nicety. A media element fed a
 * stream of unknown length reports its duration as Infinity — the clock sits at
 * 0:00 and the waveform has nothing to scale itself against, while the song
 * plays perfectly well. It is also what lets a forty-five minute lesson be
 * seeked without reading the whole thing first, which over a phone's connection
 * to Drive is the difference between working and not.
 */
public class SongStream extends BridgeWebViewClient {

    private static final String PREFIX = "/_song/";
    private final Context context;

    public SongStream(Bridge bridge) {
        super(bridge);
        this.context = bridge.getContext();
    }

    /** The address the page uses for a song it has been given. */
    public static String urlFor(String contentUri) {
        return "https://localhost" + PREFIX
            + Base64.encodeToString(contentUri.getBytes(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(android.webkit.WebView view, WebResourceRequest request) {
        Uri asked = request.getUrl();
        if (asked == null || asked.getPath() == null || !asked.getPath().startsWith(PREFIX)) {
            return super.shouldInterceptRequest(view, request);
        }
        String encoded = asked.getPath().substring(PREFIX.length());
        Uri target;
        try {
            target = Uri.parse(new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)));
        } catch (Exception bad) {
            return refuse(400, "Bad Request");
        }

        long total = sizeOf(context, target);
        Ranges.Plan plan = Ranges.plan(header(request, "Range"), total);

        if (plan.status == 416) {
            WebResourceResponse refused = refuse(416, "Range Not Satisfiable");
            Map<String, String> headers = new HashMap<>();
            headers.put("Content-Range", plan.contentRange);
            refused.setResponseHeaders(headers);
            return refused;
        }

        try {
            InputStream raw = context.getContentResolver().openInputStream(target);
            if (raw == null) return refuse(404, "Not Found");
            InputStream body = plan.slices()
                ? new Slice(raw, plan.start, plan.end >= 0 ? plan.end - plan.start + 1 : Long.MAX_VALUE)
                : raw;

            Map<String, String> headers = new HashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "no-store");
            /* The page is served from https://localhost and asks for this from
               the same origin, but a media element whose source is treated as
               cross-origin is TAINTED — and createMediaElementSource on a
               tainted element feeds SILENCE into the graph rather than failing.
               The song would appear to play with the clock running and nothing
               audible, which is a fault the Windows app met once already. */
            headers.put("Access-Control-Allow-Origin", "*");
            if (plan.contentLength >= 0) headers.put("Content-Length", String.valueOf(plan.contentLength));
            if (plan.contentRange != null) headers.put("Content-Range", plan.contentRange);

            WebResourceResponse response = new WebResourceResponse(
                Ranges.mimeForName(nameOf(context, target)), null, body);
            response.setResponseHeaders(headers);
            response.setStatusCodeAndReasonPhrase(plan.status,
                plan.status == 206 ? "Partial Content" : "OK");
            return response;
        } catch (Exception err) {
            return refuse(404, "Not Found");
        }
    }

    private static String header(WebResourceRequest request, String name) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }

    private WebResourceResponse refuse(int code, String why) {
        WebResourceResponse response = new WebResourceResponse(
            "text/plain", "utf-8", new java.io.ByteArrayInputStream(why.getBytes()));
        response.setStatusCodeAndReasonPhrase(code, why);
        response.setResponseHeaders(new HashMap<>());
        return response;
    }

    /**
     * How long the file is, asked the most dependable way first.
     *
     * THE WHOLE THING TURNS ON THIS NUMBER. With it, the song can be seeked and
     * its duration is known; without it the app can only stream from the start.
     * So it is asked twice, differently: the file descriptor is what a provider
     * opens to hand the bytes over and it nearly always knows the length, while
     * the SIZE column is only as good as what the provider chose to put in its
     * database — and for a file in OneDrive or Drive that can be nothing at all.
     */
    static long sizeOf(Context context, Uri uri) {
        try (AssetFileDescriptor fd = context.getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (fd != null) {
                long length = fd.getLength();
                if (length >= 0 && length != AssetFileDescriptor.UNKNOWN_LENGTH) return length;
            }
        } catch (Exception ignored) {
            /* A provider that will not open a descriptor. The column is tried
               next rather than this being the end of it. */
        }
        try (Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int at = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                if (at >= 0 && !cursor.isNull(at)) return cursor.getLong(at);
            }
        } catch (Exception ignored) { /* a provider that will not say */ }
        return -1;
    }

    static String nameOf(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int at = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                if (at >= 0 && !cursor.isNull(at)) return cursor.getString(at);
            }
        } catch (Exception ignored) { /* fall back to the URI's own tail */ }
        String tail = uri.getLastPathSegment();
        return tail == null ? "" : tail;
    }
}
