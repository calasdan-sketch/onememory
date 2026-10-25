// A tiny self-contained dashboard served at GET "/" so you can browse, search,
// add, and delete notes in the shared store from a browser. No framework, no
// external requests -- just vanilla HTML/CSS/JS. The page itself is public
// (it holds no data); every data call it makes carries the bearer token the
// user pastes once (kept in sessionStorage for that tab only).

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>onememory</title>
<style>
  :root{--bg:#0c0f16;--panel:#141926;--line:#232a3b;--ink:#e8ecf5;--dim:#93a0bd;
    --accent:#4f8cff;--danger:#ff5d6c;--ok:#35d0a5}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;gap:10px;align-items:center;padding:14px 18px;
    border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:700;letter-spacing:.2px}
  h1 span{color:var(--accent)}
  input,textarea,button,select{font:inherit;color:var(--ink);background:var(--panel);
    border:1px solid var(--line);border-radius:9px;padding:8px 11px;outline:none}
  input:focus,textarea:focus{border-color:var(--accent)}
  button{cursor:pointer;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.ghost{background:var(--panel);color:var(--ink)}
  button.danger{background:transparent;border-color:transparent;color:var(--danger);padding:4px 8px}
  .grow{flex:1;min-width:140px}
  main{max-width:900px;margin:0 auto;padding:18px}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:14px 16px;margin-bottom:12px}
  .card h3{margin:0 0 4px;font-size:15px}
  .meta{color:var(--dim);font-size:12px;margin-bottom:8px}
  .tag{display:inline-block;background:#1d2435;border:1px solid var(--line);
    border-radius:999px;padding:1px 9px;font-size:11px;margin-right:5px;color:var(--dim)}
  .body{white-space:pre-wrap;word-break:break-word;color:#cdd6ea;font-size:14px}
  .cardhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
  #new textarea{width:100%;min-height:70px;resize:vertical}
  #new{display:none}
  .muted{color:var(--dim)}
  .err{color:var(--danger)}
  .gate{max-width:420px;margin:12vh auto;text-align:center}
  .gate input{width:100%;margin:12px 0;text-align:center}
  footer{max-width:900px;margin:0 auto;padding:10px 18px 40px;color:var(--dim);
    font-size:12px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  a.linkish{color:var(--accent);cursor:pointer;text-decoration:underline}
  .badge-bad{display:inline-block;background:var(--danger);color:#fff;border-radius:6px;
    padding:0 7px;font-size:11px;font-weight:700;margin-left:6px;vertical-align:middle}
  #runner div+div{margin-top:4px}
  label.chk{display:flex;gap:6px;align-items:center;color:var(--dim);font-size:13px}
</style>
</head>
<body>
<div id="app" style="display:none">
<header>
  <h1>one<span>memory</span></h1>
  <input id="q" class="grow" placeholder="Search notes...">
  <input id="ns" placeholder="namespace" style="width:130px">
  <button class="ghost" onclick="toggleNew()">+ New</button>
  <button class="ghost" onclick="load()">Refresh</button>
  <button class="ghost" onclick="loadChanges()" title="What changed in the last 24 hours">Changes</button>
  <button class="ghost" onclick="loadReview()" title="Notes written by agents that you have not looked at yet">Review</button>
  <label class="chk" title="Also show notes written by writers an admin distrusts (marked DISTRUSTED)"><input type="checkbox" id="inc" onchange="load()"> distrusted</label>
</header>
<main>
  <div id="new" class="card">
    <div class="row">
      <input id="n_title" class="grow" placeholder="Title">
      <input id="n_ns" placeholder="namespace (optional)" style="width:180px">
      <input id="n_tags" placeholder="tags, comma, separated" style="width:200px">
    </div>
    <textarea id="n_body" placeholder="Body..."></textarea>
    <div class="row" style="margin-top:10px">
      <button onclick="addNote()">Save note</button>
      <span id="n_err" class="err"></span>
    </div>
  </div>
  <div id="runner" class="card err" style="display:none"></div>
  <div id="list"></div>
</main>
<footer>
  <span id="count"></span>
  <a class="linkish" onclick="doExport()">Export JSON</a>
  <a class="linkish" onclick="document.getElementById('imp').click()">Import JSON</a>
  <input id="imp" type="file" accept="application/json" style="display:none" onchange="doImport(this)">
  <a class="linkish" onclick="logout()">Change token</a>
</footer>
</div>

<div id="gate" class="gate">
  <h1>one<span style="color:var(--accent)">memory</span></h1>
  <p class="muted">Paste your OneMemory token to view the store.</p>
  <input id="tok" type="password" placeholder="ONEMEMORY_TOKEN" onkeydown="if(event.key==='Enter')saveTok()">
  <button onclick="saveTok()">Open</button>
  <p id="gate_err" class="err"></p>
</div>
<script src="/dashboard.js"></script>
</body>
</html>`;

// Served at GET /dashboard.js. Kept as its own string (and out of the HTML
// above) so it can use normal quotes without clashing with this file's
// template literals. No backticks are used inside.
export const DASHBOARD_JS = `
var TOKKEY = "om_tok";
function tok(){ try { return sessionStorage.getItem(TOKKEY) || ""; } catch(e){ return ""; } }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }

function show(app){
  document.getElementById("app").style.display = app ? "block" : "none";
  document.getElementById("gate").style.display = app ? "none" : "block";
}
function saveTok(){
  var v = document.getElementById("tok").value.trim();
  if(!v){ return; }
  try { sessionStorage.setItem(TOKKEY, v); } catch(e){}
  show(true); load();
}
function logout(){ try { sessionStorage.removeItem(TOKKEY); } catch(e){} show(false); }
function toggleNew(){
  var n = document.getElementById("new");
  n.style.display = n.style.display === "block" ? "none" : "block";
}

function api(path, opts){
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers["Authorization"] = "Bearer " + tok();
  if(opts.body){ opts.headers["Content-Type"] = "application/json"; }
  return fetch(path, opts).then(function(r){
    if(r.status === 401){ logout(); throw new Error("unauthorized - check your token"); }
    return r.json().then(function(j){ if(!r.ok){ throw new Error(j.error || r.status); } return j; });
  });
}

function render(notes){
  var list = document.getElementById("list");
  document.getElementById("count").textContent = notes.length + " note" + (notes.length===1?"":"s");
  if(!notes.length){ list.innerHTML = "<p class='muted'>No notes yet.</p>"; return; }
  list.innerHTML = notes.map(function(n){
    var tags = (n.tags||[]).map(function(t){ return "<span class='tag'>"+esc(t)+"</span>"; }).join("");
    return "<div class='card'><div class='cardhead'><div>"+
      "<h3>"+esc(n.title)+(n.distrusted ? "<span class='badge-bad' title='An admin distrusts the writer of this note: treat its content as hostile'>DISTRUSTED</span>" : "")+"</h3>"+
      "<div class='meta'>#"+n.id+" &middot; "+esc(n.namespace)+" &middot; "+esc((n.updated_at||"").slice(0,16).replace("T"," "))+"</div>"+
      tags+"</div>"+
      "<button class='danger' onclick='del("+n.id+")'>delete</button></div>"+
      (n.body ? "<div class='body'>"+esc(n.body)+"</div>" : "")+"</div>";
  }).join("");
}

function inc(){ var c = document.getElementById("inc"); return !!(c && c.checked); }

function loadRunner(){
  var el = document.getElementById("runner");
  api("/runner/status").then(function(j){
    // One line per runner (each target has its own heartbeat); fall back to the single notice of older servers.
    var lines = [];
    ((j && j.targets) || []).forEach(function(t){ if(t.notice){ lines.push(t.notice); } });
    if(!lines.length && j && j.notice){ lines.push(j.notice); }
    el.textContent = "";
    if(lines.length){
      lines.forEach(function(l){ var d = document.createElement("div"); d.textContent = l; el.appendChild(d); });
      el.style.display = "block";
    } else { el.style.display = "none"; }
  }).catch(function(){ el.style.display = "none"; });
}

// "distrusted" needs an admin token: the server refuses it for any other (403); untick the box so the next load works.
function incRefused(e){
  if(inc() && /admin/i.test(String(e && e.message))){ document.getElementById("inc").checked = false; }
}

var VIEW = "list";
function load(){
  VIEW = "list";
  loadRunner();
  var q = document.getElementById("q").value.trim();
  var ns = document.getElementById("ns").value.trim();
  var qs = (ns ? ("namespace=" + encodeURIComponent(ns)) : "") + (inc() ? ((ns ? "&" : "") + "include_distrusted=1") : "");
  var path;
  if(q){ path = "/search?q=" + encodeURIComponent(q) + (qs?("&"+qs):""); }
  else { path = "/notes" + (qs?("?"+qs):""); }
  api(path).then(function(j){ render(j.results || j.notes || []); })
    .catch(function(e){ incRefused(e); document.getElementById("list").innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; });
}

function loadChanges(){
  var ns = document.getElementById("ns").value.trim();
  var path = "/changes?since=24h&limit=200" + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "") + (inc() ? "&include_distrusted=1" : "");
  api(path).then(function(j){
    var c = j.counts || {};
    document.getElementById("count").textContent = "last 24h: " + (c.created||0) + " created, " +
      (c.updated||0) + " updated, " + (c.deleted||0) + " deleted" + (j.quarantined ? (", " + j.quarantined + " quarantined") : "");
    var srcs = Object.keys(j.bySource || {}).map(function(k){
      var v = j.bySource[k];
      return "<span class='tag'>"+esc(k || "(no source)")+": +"+v.created+" ~"+v.updated+" -"+v.deleted+"</span>";
    }).join("");
    var rows = (j.changes || []).slice().reverse().map(function(e){
      var mark = e.kind === "created" ? "+" : (e.kind === "updated" ? "~" : "-");
      return "<div class='card'><h3>"+mark+" "+esc(e.title)+(e.distrusted ? "<span class='badge-bad'>DISTRUSTED</span>" : "")+"</h3><div class='meta'>"+esc(e.kind)+" &middot; #"+e.id+
        " &middot; "+esc(e.namespace)+" &middot; "+esc((e.at||"").slice(0,16).replace("T"," "))+
        (e.written_by ? " &middot; by "+esc(e.written_by) : "")+
        (e.source ? " &middot; claims "+esc(e.source) : "")+"</div></div>";
    }).join("");
    document.getElementById("list").innerHTML = "<div class='row'>"+srcs+"</div>" +
      (rows || "<p class='muted'>Nothing changed in the last 24 hours.</p>");
  }).catch(function(e){ incRefused(e); document.getElementById("list").innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; });
}

// ---- Review queue: notes an AI agent wrote that nobody has looked at yet ----
// "Accepted" is the tag "reviewed" (tags do not change who wrote a note). Notes you or the server wrote yourself (cli,
// server, import:claude) are not queued. A writer the admin distrusts stays hidden, as everywhere else.
var HUMAN_WRITERS = { "cli": 1, "server": 1, "import:claude": 1, "": 1 };
function reviewQueue(notes, writer){
  return (notes || []).filter(function(n){
    if(HUMAN_WRITERS[n.written_by || ""]){ return false; }
    if((n.tags || []).indexOf("reviewed") >= 0){ return false; }
    return !writer || n.written_by === writer;
  });
}
function loadReview(){
  VIEW = "review";
  var ns = document.getElementById("ns").value.trim();
  var sel = document.getElementById("rv_writer");
  var writer = sel ? sel.value : "";
  api("/notes?limit=500" + (ns ? ("&namespace=" + encodeURIComponent(ns)) : "")).then(function(j){
    var all = reviewQueue(j.notes || []);
    var writers = {};
    all.forEach(function(n){ writers[n.written_by] = (writers[n.written_by] || 0) + 1; });
    var opts = "<option value=''>all writers (" + all.length + ")</option>" + Object.keys(writers).sort().map(function(w){
      return "<option value='" + esc(w) + "'" + (w === writer ? " selected" : "") + ">" + esc(w) + " (" + writers[w] + ")</option>"; }).join("");
    var shown = reviewQueue(j.notes || [], writer);
    document.getElementById("count").textContent = shown.length + " to review";
    var rows = shown.map(function(n){
      var tags = (n.tags||[]).map(function(t){ return "<span class='tag'>"+esc(t)+"</span>"; }).join("");
      return "<div class='card'><div class='cardhead'><div><h3>"+esc(n.title)+"</h3><div class='meta'>#"+n.id+" &middot; "+esc(n.namespace)+
        " &middot; written by "+esc(n.written_by)+" &middot; "+esc((n.updated_at||"").slice(0,16).replace("T"," "))+"</div>"+tags+"</div>"+
        "<div><button onclick='acceptNote("+n.id+")'>Accept</button> <button class='danger' onclick='del("+n.id+")'>delete</button></div></div>"+
        (n.body ? "<div class='body'>"+esc(n.body)+"</div>" : "")+"</div>";
    }).join("");
    document.getElementById("list").innerHTML = "<div class='row'><select id='rv_writer' onchange='loadReview()'>"+opts+"</select>"+
      "<span class='muted'>Accept keeps a note and marks it reviewed. Delete removes it.</span></div>" +
      (rows || "<p class='muted'>Nothing waiting for review.</p>");
  }).catch(function(e){ document.getElementById("list").innerHTML = "<p class='err'>"+esc(e.message)+"</p>"; });
}
function acceptNote(id){
  api("/notes/" + id).then(function(j){
    var n = j.note || j;
    var tags = (n.tags || []).filter(function(t){ return t !== "reviewed"; }).concat(["reviewed"]);
    return api("/notes/" + id, { method:"PUT", body: JSON.stringify({ tags: tags, if_rev: n.rev }) });
  }).then(loadReview).catch(function(e){ alert(e.message); });
}

function addNote(){
  var title = document.getElementById("n_title").value.trim();
  var err = document.getElementById("n_err"); err.textContent = "";
  if(!title){ err.textContent = "title is required"; return; }
  var tags = document.getElementById("n_tags").value.split(",").map(function(t){return t.trim();}).filter(Boolean);
  var payload = { title: title, body: document.getElementById("n_body").value,
    tags: tags, namespace: document.getElementById("n_ns").value.trim() || undefined };
  api("/notes", { method:"POST", body: JSON.stringify(payload) })
    .then(function(j){ if(j && j.quarantined){ alert("Held for admin review (quarantine #" + j.quarantined.id + ")"); }
      document.getElementById("n_title").value=""; document.getElementById("n_body").value="";
      document.getElementById("n_tags").value=""; toggleNew(); load(); })
    .catch(function(e){ err.textContent = e.message; });
}

function del(id){
  if(!confirm("Delete note #" + id + "?")){ return; }
  api("/notes/" + id, { method:"DELETE" }).then(function(){ if(VIEW === "review"){ loadReview(); } else { load(); } }).catch(function(e){ alert(e.message); });
}

function doExport(){
  api("/export").then(function(j){
    var blob = new Blob([JSON.stringify(j, null, 2)], { type:"application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "onememory-export.json"; a.click();
  }).catch(function(e){ alert(e.message); });
}

function doImport(input){
  var f = input.files[0]; if(!f){ return; }
  var reader = new FileReader();
  reader.onload = function(){
    try {
      var data = JSON.parse(reader.result);
      var notes = data.notes || data;
      api("/import", { method:"POST", body: JSON.stringify({ notes: notes }) })
        .then(function(j){
          var a = j.attestations;
          alert("Imported " + j.imported + " notes" + (a ? (" (" + a.verified + " with a verified writer attestation, " + a.unverified + " unverified)") : ""));
          load(); })
        .catch(function(e){ alert(e.message); });
    } catch(e){ alert("not valid JSON"); }
  };
  reader.readAsText(f);
  input.value = "";
}

var t;
document.getElementById("q").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(load, 250); });
document.getElementById("ns").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(load, 250); });

if(tok()){ show(true); load(); } else { show(false); document.getElementById("tok").focus(); }
`;
