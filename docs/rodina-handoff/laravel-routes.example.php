<?php
// Example only. Adapt in routes/web.php after reviewing the existing routes.
// Copy public/rodina-assets/ and all ten page directories into public_path().
// Do NOT overwrite the site's index.php or copy the preview public/index.html.
// Agree exact final callback paths (including trailing slash) with Viva first.
// Existing nginx directory handling may serve these files before PHP is reached.

use Illuminate\Support\Facades\Route;
use Illuminate\Http\Request;

$rodinaPageSlugs = [
    'rodina',
    'rodina-alekseevskaya',
    'rodina-belorusskaya',
    'rodina-bratislavskaya',
    'rodina-gagarina',
    'rodina-kantemirovskaya',
    'rodina-kurkino',
    'rodina-novatorskaya',
    'rodina-polezhaevskaya',
    'rodina-sevastopolskaya',
];

foreach ($rodinaPageSlugs as $rodinaPageSlug) {
    Route::get('/' . $rodinaPageSlug, function (Request $request) use ($rodinaPageSlug) {
        if (substr($request->getPathInfo(), -1) !== '/') {
            // Canonicalize before OAuth begins. Never silently change a callback.
            foreach (['code', 'state', 'error'] as $callbackKey) {
                if ($request->query->has($callbackKey)) {
                    return response('OAuth callback path mismatch. Check the registered trailing-slash URL.', 409);
                }
            }
            $query = $request->getQueryString();
            return redirect('/' . $rodinaPageSlug . '/' . ($query ? '?' . $query : ''), 302);
        }
        return response()->file(
            public_path($rodinaPageSlug . '/index.html'),
            ['Content-Type' => 'text/html; charset=UTF-8']
        );
    })->name('rodina.handoff.' . $rodinaPageSlug);
}
