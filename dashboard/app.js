// Token Radar dashboard — renders window.TOKEN_RADAR (written by main.ts).
// No network: every number on this page comes from the snapshot's own data.
(function () {
  "use strict";
  var DATA = window.TOKEN_RADAR || { rows: [], model: {} };
  var rows = DATA.rows || [];
  var model = DATA.model || {};
  var selected = null;

  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n === null || n === undefined) return "—";
    var abs = Math.abs(n);
    if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + Math.round(n);
  }
  function moneyFull(n) {
    if (n === null || n === undefined) return "—";
    var sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
  }
  function pct(n) {
    if (n === null || n === undefined) return "—";
    return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function headline() {
    var verdicts = DATA.verdicts || {};
    var top = rows[0];
    $("headline-stats").innerHTML =
      stat("Protocols", rows.length) +
      stat("Watchlist", DATA.watchlist_covered || "—") +
      stat("Comparables", model.comps_n || "—") +
      stat("FARM", verdicts.FARM || 0) +
      stat("Top pick", top ? esc(top.name) : "—");
    $("as-of").textContent = DATA.as_of || "";
    function stat(label, value) {
      return "<div><dt>" + label + "</dt><dd>" + value + "</dd></div>";
    }
  }

  function method() {
    $("method-formula").textContent = model.formula || "";
    var curve = model.curve || {};
    var blind = model.blind || {};
    $("method-curve").textContent =
      "Fitted curve: " + (curve.formula || "—") +
      " over " + (curve.n || "—") + " cleaned comparables (R² " +
      (curve.r2 === undefined ? "—" : curve.r2.toFixed(3)) + "). " +
      "The curve is fitted from the snapshot at run time; nothing about it is hardcoded.";
    $("method-blind").textContent =
      "Blind test: fitted on the " + (blind.fit_n || "—") +
      " oldest comparables, tested on the " + (blind.test_n || "—") +
      " newest, which the fit never saw — median error ×" +
      (blind.median_log_error === undefined ? "—" : Math.pow(10, blind.median_log_error).toFixed(2)) +
      ", median ratio " + (blind.median_ratio === undefined ? "—" : blind.median_ratio.toFixed(2)) +
      " (10th–90th percentile " +
      (blind.p10_ratio === undefined ? "—" : blind.p10_ratio.toFixed(2)) + "–" +
      (blind.p90_ratio === undefined ? "—" : blind.p90_ratio.toFixed(2)) + ").";
    $("method-verdicts").textContent = model.verdict_rule || "";
    var yard = model.yardsticks || {};
    var names = Object.keys(yard).sort();
    var html = "";
    for (var i = 0; i < names.length; i++) {
      html += "<tr><td>" + esc(names[i]) + "</td><td>" + yard[names[i]].toFixed(3) + "x</td></tr>";
    }
    html += "<tr><td>Global median</td><td>" +
      (model.global_median_multiple === undefined ? "—" : model.global_median_multiple.toFixed(3)) +
      "x</td></tr>";
    document.querySelector("#yardsticks tbody").innerHTML = html;
  }

  function categories() {
    var seen = {};
    rows.forEach(function (r) { if (r.category) seen[r.category] = true; });
    var select = $("category");
    Object.keys(seen).sort().forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });
  }

  function filtered() {
    var q = ($("q").value || "").trim().toLowerCase();
    var cat = $("category").value;
    var verdict = $("verdict").value;
    var wlOnly = $("watchlist-only").checked;
    var list = rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      if (cat && r.category !== cat) return false;
      if (verdict && r.verdict !== verdict) return false;
      if (wlOnly && !r.watchlist) return false;
      return true;
    });
    var sort = $("sort").value;
    var key = {
      implied: function (r) { return -r.implied_value_usd; },
      tvl: function (r) { return -r.tvl_usd; },
      change: function (r) { return -(r.change_7d === null ? -999 : r.change_7d); },
      age: function (r) { return -r.age_years; },
      name: function (r) { return r.name; },
    }[sort];
    list.sort(function (a, b) {
      var ka = key(a), kb = key(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a.slug < b.slug ? -1 : 1;
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    var body = document.querySelector("#board tbody");
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      html += "<tr data-slug=\"" + esc(r.slug) + "\"" +
        (selected === r.slug ? " class=\"selected\"" : "") + ">" +
        "<td class=\"num\">" + r.rank + "</td>" +
        "<td><span class=\"name\">" + esc(r.name) + "</span>" +
        (r.watchlist ? " ★" : "") + "<br><span class=\"slug\">" + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category || "—") + "</td>" +
        "<td>" + esc(r.chains.join(", ")) + "</td>" +
        "<td class=\"num\">" + money(r.tvl_usd) + "</td>" +
        "<td class=\"num" + ((r.change_7d || 0) < 0 ? " neg" : "") + "\">" + pct(r.change_7d) + "</td>" +
        "<td class=\"num\">" + r.age_years.toFixed(1) + "y</td>" +
        "<td class=\"num\"><b>" + money(r.implied_value_usd) + "</b></td>" +
        "<td><span class=\"verdict " + r.verdict + "\">" + r.verdict + "</span></td>" +
        "<td class=\"num\">" + moneyFull(r.farm_cost_usd) + "</td>" +
        "<td class=\"num" + (r.net_usd < 0 ? " neg" : "") + "\">" + moneyFull(r.net_usd) + "</td>" +
        "</tr>";
    }
    body.innerHTML = html || "<tr><td colspan=\"11\">No protocols match the filter.</td></tr>";
    $("count").textContent = list.length + " of " + rows.length + " protocols";
    body.querySelectorAll("tr[data-slug]").forEach(function (tr) {
      tr.addEventListener("click", function () { showDetail(tr.getAttribute("data-slug")); });
    });
  }

  function showDetail(slug) {
    var r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) r = rows[i];
    if (!r) return;
    selected = slug;
    var curve = model.curve || {};
    var steps = r.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
    $("detail-body").innerHTML =
      "<h2>" + esc(r.name) + " <span class=\"slug\">" + esc(r.slug) + " · rank #" + r.rank +
      (r.watchlist ? " · watchlist ★" : "") + "</span></h2>" +
      "<dl>" +
      "<div><dt>Implied value</dt><dd>" + moneyFull(r.implied_value_usd) + "</dd></div>" +
      "<div><dt>TVL</dt><dd>" + moneyFull(r.tvl_usd) + "</dd></div>" +
      "<div><dt>7-day change</dt><dd>" + pct(r.change_7d) + "</dd></div>" +
      "<div><dt>Age, no token</dt><dd>" + r.age_years.toFixed(2) + " years</dd></div>" +
      "<div><dt>Verdict</dt><dd><span class=\"verdict " + r.verdict + "\">" + r.verdict + "</span></dd></div>" +
      "<div><dt>Farm cost</dt><dd>" + moneyFull(r.farm_cost_usd) + "</dd></div>" +
      "<div><dt>Illustrative slice</dt><dd>" + moneyFull(r.expected_value_usd) + "</dd></div>" +
      "<div><dt>Net</dt><dd>" + moneyFull(r.net_usd) + "</dd></div>" +
      "</dl>" +
      "<h3>How the value is built</h3>" +
      "<p class=\"math\">" + esc(moneyFull(r.curve_value_usd)) + " (size curve) and " +
      esc(moneyFull(r.yardstick_value_usd)) + " (category yardstick) → base " +
      esc(moneyFull(Math.round(Math.sqrt(r.curve_value_usd * r.yardstick_value_usd)))) +
      " (geometric mean) × growth " + r.growth_factor.toFixed(3) + " × age " + r.maturity_factor.toFixed(3) +
      " = " + esc(moneyFull(r.implied_value_usd)) + "</p>" +
      "<p class=\"fine\">Size curve: " + esc(curve.formula || "—") + " over " +
      (curve.n || "—") + " cleaned comparables. The yardstick is the category's median " +
      "market-cap / TVL; thin rows also use their ten nearest comparables by size.</p>" +
      "<h3>Farm plan — " + esc(r.chains.join(", ")) + "</h3>" +
      "<ol>" + steps + "</ol>";
    $("detail").hidden = false;
    renderBoard();
    $("detail").scrollIntoView({ block: "nearest" });
  }

  ["q", "category", "verdict", "sort", "watchlist-only"].forEach(function (id) {
    $(id).addEventListener("input", renderBoard);
    $(id).addEventListener("change", renderBoard);
  });
  $("detail-close").addEventListener("click", function () {
    selected = null;
    $("detail").hidden = true;
    renderBoard();
  });

  headline();
  method();
  categories();
  renderBoard();
})();
