package com.wb.remoteagent;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** 列出桌面可见的应用，供控制端「打开 App」使用。 */
public final class AppCatalog {

    private AppCatalog() {}

    public static JSONArray listLaunchable(Context ctx) {
        JSONArray arr = new JSONArray();
        PackageManager pm = ctx.getPackageManager();

        List<ResolveInfo> ris;
        try {
            Intent main = new Intent(Intent.ACTION_MAIN, null);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            ris = pm.queryIntentActivities(main, 0);
        } catch (Throwable e) {
            return arr;
        }
        if (ris == null) return arr;

        List<JSONObject> items = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (ResolveInfo ri : ris) {
            try {
                if (ri == null || ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (pkg == null || pkg.equals(ctx.getPackageName())) continue;
                if (!seen.add(pkg)) continue;

                CharSequence label = ri.loadLabel(pm);
                JSONObject o = new JSONObject();
                o.put("n", label == null ? pkg : label.toString());
                o.put("p", pkg);
                items.add(o);
            } catch (Throwable ignored) {
            }
        }

        Collections.sort(items, (a, b) ->
                a.optString("n").compareToIgnoreCase(b.optString("n")));

        for (JSONObject o : items) arr.put(o);
        return arr;
    }
}
