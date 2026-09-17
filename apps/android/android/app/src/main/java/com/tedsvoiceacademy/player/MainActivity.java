package com.tedsvoiceacademy.player;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* Registered BEFORE super.onCreate, which is when Capacitor builds the
           bridge and loads the page. Added afterwards, the plugin exists but the
           page has already asked for it and been told there is no such thing. */
        registerPlugin(Files.class);
        registerPlugin(Takes.class);
        registerPlugin(Playback.class);
        super.onCreate(savedInstanceState);

        /* Songs reach the audio element through this. See SongStream.
         *
         * THROUGH THE BRIDGE, NOT THE WEBVIEW. Capacitor keeps its own reference
         * to the client and re-applies it when the web view is set up again, so
         * setting it straight on the view leaves the two disagreeing — and the
         * one that gets re-applied is Capacitor's, which knows nothing about
         * serving a song. bridge.setWebViewClient sets both. */
        getBridge().setWebViewClient(new SongStream(getBridge()));
    }
}
