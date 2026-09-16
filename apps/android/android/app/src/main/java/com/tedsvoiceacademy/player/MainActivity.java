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

        /* Songs reach the audio element through this. See SongStream. */
        getBridge().getWebView().setWebViewClient(new SongStream(getBridge()));
    }
}
