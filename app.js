(function () {
  "use strict";

  var API_BASE = "https://drinking-fountains-api.urbanfreerunners.com";

  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  var SEATTLE_CENTER = [47.6062, -122.3321];
  var DEFAULT_ZOOM = 13;
  var SEARCH_ZOOM = 16;

  function getDeviceId() {
    var key = "fountain_device_id";
    var id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }
  var deviceId = getDeviceId();

  var fountainIndex = {};
  var fountainIndexLoaded = false;
  var powerUserMode = false;
  var myRatings = {}; // fountainId -> 0 | 1 | null
  var myNotFoundReports = {}; // fountainId -> true
  var adminToken = null;
  var locateBtn = null;

  var map = L.map("map", {
    center: SEATTLE_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: false,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  var LocateControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      var container = L.DomUtil.create("div", "leaflet-bar leaflet-control leaflet-control-locate");
      var btn = L.DomUtil.create("a", "", container);
      btn.href = "#";
      btn.title = "Use my location";
      btn.setAttribute("aria-label", "Use my location");
      btn.setAttribute("role", "button");
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path fill="currentColor" stroke="none" d="M12 5 L17 16 L12 13 L7 16 Z" transform="rotate(22.5 12 12)"/></svg>';
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.preventDefault(e);
        locateUser();
      });
      locateBtn = btn;
      return container;
    },
  });
  new LocateControl().addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  var userMarker = null;
  var cachedPosition = null;
  var locationDenied = false;

  var activeFilters = {
    accessible: false,
    bottle: false,
    dog: false,
  };

  var sources = {
    city: { layerGroup: L.layerGroup().addTo(map), visible: true },
    osm:  { layerGroup: L.layerGroup().addTo(map), visible: true },
  };

  var layerOptions = {
    cityUniqueOnly: false,
    ratingFilter: null, // null | "rated" | "unrated" | "rated-7d"
    showNotFound: false,
  };

  function isYes(val) {
    return typeof val === "string" && val.toUpperCase() === "YES";
  }

  function isCityRunning(sd) {
    return sd.CURRENT_STATUS === "ON" || sd.CURRENT_STATUS === null || sd.CURRENT_STATUS === undefined;
  }

  function isCityShutOff(local) {
    var sd = getSourceData(local, "city_gis");
    return sd ? !isCityRunning(sd) : false;
  }

  function getSourceData(local, sourceType) {
    var src = (local.sources || []).find(function (s) { return s.source_type === sourceType && s.source_data !== null; });
    return src ? src.source_data : null;
  }

  function fountainHasOsmMatch(local) {
    return (local.sources || []).some(function (s) { return s.source_type === "osm" && s.source_data !== null; });
  }

  function fountainHasCityGisMatch(local) {
    return (local.sources || []).some(function (s) { return s.source_type === "city_gis" && s.source_data !== null; });
  }

  function fountainHasAccessible(local) {
    if (local.user_accessible) return true;
    var city = getSourceData(local, "city_gis");
    if (city) return isYes(city.ACCESSIBLE_MODEL);
    var osm = getSourceData(local, "osm");
    if (osm) return (osm.tags || {}).wheelchair === "yes";
    return false;
  }

  function fountainHasBottle(local) {
    if (local.user_bottle_filler) return true;
    var city = getSourceData(local, "city_gis");
    if (city) return isYes(city.BOTTLE_FILLER);
    var osm = getSourceData(local, "osm");
    if (osm) return (osm.tags || {}).bottle === "yes";
    return false;
  }

  function fountainHasDog(local) {
    if (local.user_dog_bowl) return true;
    var city = getSourceData(local, "city_gis");
    if (city) return isYes(city.DOG_BOWL);
    var osm = getSourceData(local, "osm");
    if (osm) return (osm.tags || {}).dog === "yes";
    return false;
  }

  var X_ICON = '<line x1="9" y1="10" x2="19" y2="20" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.9"/>' +
    '<line x1="19" y1="10" x2="9" y2="20" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.9"/>';

  var QUESTION_ICON = '<text x="14" y="19" text-anchor="middle" fill="#fff" font-size="15" font-weight="bold" font-family="Arial, sans-serif" opacity="0.9">?</text>';

  var THUMB_UP   = '<text x="14" y="20" text-anchor="middle" font-size="14" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">👍</text>';
  var THUMB_DOWN = '<text x="14" y="20" text-anchor="middle" font-size="14" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">👎</text>';

  function makeIcon(color, inner) {
    return L.divIcon({
      className: "fountain-marker",
      html: '<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>' +
        inner +
      '</svg>',
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -30],
    });
  }

  var icons = {
    reportedOff:    makeIcon("#e67e22", X_ICON),
    reportedNotFound: makeIcon("#e67e22", QUESTION_ICON),
  };

  function lookupFountain(sourceType, sourceId) {
    return fountainIndex[sourceType + ":" + sourceId] || null;
  }

  function getPinStateForLocal(local) {
    if (!fountainIndexLoaded || !local || !local.rating_count) return "unrated";
    if (local.thumbs_down > local.thumbs_up) return "down";
    return "up";
  }

  function hasUserContribution(local) {
    if (!local) return false;
    return local.rating_count > 0 ||
           local.user_accessible ||
           local.user_bottle_filler ||
           local.user_dog_bowl ||
           local.off_reports > 0 ||
           local.not_found_count > 0;
  }

  function passesRatingFilter(local) {
    if (!layerOptions.ratingFilter) return true;
    if (layerOptions.ratingFilter === "rated-7d") {
      var ts = local && (local.last_contributed_at || local.last_rated_at);
      if (!ts) return false;
      return (Date.now() - new Date(ts).getTime()) < 7 * 86400000;
    }
    var acted = hasUserContribution(local);
    return layerOptions.ratingFilter === "rated" ? acted : !acted;
  }

  function formatRelativeDate(isoString) {
    if (!isoString) return "";
    var date = new Date(isoString);
    var now = new Date();
    var diffMs = now - date;
    var diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return diffDays + " days ago";
    if (diffDays < 30) return Math.floor(diffDays / 7) + "w ago";
    var month = date.toLocaleString("en-US", { month: "short" });
    return month + " " + date.getDate();
  }

  var POPUP_BORDER_COLORS = {
    notthere: "#e67e22", nowater: "#df6a30", working: "#2f6fed", unrated: "#a7adb5"
  };

  function getPopupState(local) {
    if (local.not_found_count > 0) return "notthere";
    if (local.reported_off) return "nowater";
    if (local.rating_count > 0) return "working";
    return "unrated";
  }

  function getPopupSourceLine(local) {
    var citySD = getSourceData(local, "city_gis");
    var osmSD = getSourceData(local, "osm");
    var tags = osmSD ? osmSD.tags || {} : {};
    var sourceLabel = citySD ? "Seattle City GIS" : "OpenStreetMap";
    var title = (citySD && citySD.PARK) || null;
    if (!title && tags.name && tags.name !== "Drinking Fountain") title = tags.name;
    return '<p class="popup-meta">' + (title ? title + " · " : "") + sourceLabel + '</p>';
  }

  function buildPopupMain(local) {
    var state = getPopupState(local);

    if (state === "notthere") {
      var nfHtml = '<div class="popup-status-head">' +
        '<span class="popup-ico">?</span>' +
        '<div class="popup-txt">' +
          '<span class="popup-word" style="color:#e67e22">Not there</span>' +
          '<span class="popup-when">Reported by ' + local.not_found_count + '.</br> ' + (3 - local.not_found_count) + ' more will make it disappear.</span>' +
        '</div></div>' +
        '<div class="popup-action-stack">' +
          '<button class="popup-action-btn" data-act="confirmGone" data-fountain-id="' + local.id + '">' +
            '<span class="popup-ico">?</span><span class="popup-lbl">Confirm not there</span></button>' +
          '<button class="popup-action-btn" data-act="foundIt" data-fountain-id="' + local.id + '">' +
            '<span class="popup-ico">👍</span><span class="popup-lbl">Undo — I found it</span></button>' +
        '</div>';
      if (powerUserMode) {
        nfHtml += '<div class="popup-action-stack" style="margin-top:7px">' +
          '<button class="popup-action-btn" data-act="reinstate" data-fountain-id="' + local.id + '">' +
            '<span class="popup-ico">♻</span><span class="popup-lbl">Reinstate (admin)</span></button>' +
          '</div>';
      }
      return nfHtml + getPopupSourceLine(local);
    }

    if (state === "nowater") {
      return '<div class="popup-status-head">' +
        '<span class="popup-ico">✕</span>' +
        '<div class="popup-txt">' +
          '<span class="popup-word" style="color:#df6a30">No water</span>' +
          '<span class="popup-when">reported ' + formatRelativeDate(local.last_off_report_at) + '</span>' +
        '</div></div>' +
        '<div class="popup-action-stack">' +
          '<button class="popup-action-btn" data-act="flowing" data-fountain-id="' + local.id + '">' +
            '<span class="popup-ico">👍</span><span class="popup-lbl">Water\'s flowing again!</span></button>' +
        '</div>' +
        getPopupSourceLine(local);
    }

    // unrated / working
    var myScore = myRatings[local.id] !== undefined ? myRatings[local.id] : null;
    var upChosen = myScore === 1 ? " chosen" : "";
    var downChosen = myScore === 0 ? " chosen" : "";
    var total = (local.thumbs_up || 0) + (local.thumbs_down || 0);

    var html = '<div class="popup-action-stack">' +
      '<button class="popup-action-btn' + upChosen + '" data-vote="1" data-fountain-id="' + local.id + '">' +
        '<span class="popup-ico">👍</span><span class="popup-lbl">I drank here</span>' +
        '<span class="popup-count">' + (local.thumbs_up || 0) + '</span></button>' +
      '<button class="popup-action-btn decline' + downChosen + '" data-vote="0" data-fountain-id="' + local.id + '">' +
        '<span class="popup-ico">👎</span><span class="popup-lbl">I chose not to</span>' +
        '<span class="popup-count">' + (local.thumbs_down || 0) + '</span></button>' +
    '</div>';

    if (total > 0) {
      html += '<p class="popup-summary">' + (local.thumbs_up || 0) + ' of ' + total +
        ' people drank here as of ' + formatRelativeDate(local.last_rated_at) + '</p>';
    }

    html += '<hr class="popup-hr">';

    // Amenity pills
    var citySD = getSourceData(local, "city_gis");
    var osmSD = getSourceData(local, "osm");
    var sourceAccessible = citySD ? isYes(citySD.ACCESSIBLE_MODEL) : (osmSD && osmSD.tags ? osmSD.tags.wheelchair === "yes" : false);
    var accActive = (sourceAccessible || local.user_accessible) ? " active" : "";
    var bottleActive = local.user_bottle_filler ? " active" : "";
    var dogActive = local.user_dog_bowl ? " active" : "";

    html += '<div class="popup-pill-row">' +
      '<button class="popup-pill' + accActive + '" data-fountain-id="' + local.id + '" data-attribute="accessible">♿ Accessible</button>' +
      '<button class="popup-pill' + bottleActive + '" data-fountain-id="' + local.id + '" data-attribute="bottle_filler">🚰 Bottle filler</button>' +
      '<button class="popup-pill' + dogActive + '" data-fountain-id="' + local.id + '" data-attribute="dog_bowl">🐾 Dog bowl</button>' +
    '</div>';

    // Report row
    html += '<div class="popup-action-stack" style="margin-top:13px">' +
      '<button class="popup-action-btn popup-report-row" data-act="openReport" data-fountain-id="' + local.id + '">' +
        '<span class="popup-ico">⚠️</span><span class="popup-lbl">Report an issue</span>' +
        '<span class="popup-chev">›</span></button>' +
    '</div>';

    html += getPopupSourceLine(local);
    return html;
  }

  function buildPopupReport(local, confirmStep) {
    var html = '<button class="popup-back" data-act="backToMain" data-fountain-id="' + local.id + '">‹ Back</button>' +
      '<p class="popup-issue-title">Report an issue</p>' +
      '<button class="popup-issue-option" data-act="reportNoWater" data-fountain-id="' + local.id + '">' +
        '<span class="popup-ico">✕</span>' +
        '<div class="popup-option-txt"><span class="popup-option-lbl">No water</span>' +
        '<span class="popup-option-sub">No water comes out</span></div></button>';

    if (confirmStep) {
      html += '<div class="popup-confirm-box">' +
        '<p>Are you sure this fountain is missing? Reporting it may remove it from the map.</p>' +
        '<div class="popup-confirm-row">' +
          '<button style="background:#78828e" data-act="reportGone" data-fountain-id="' + local.id + '">Yes, report it</button>' +
          '<button style="background:#c7ccd3" data-act="cancelGone" data-fountain-id="' + local.id + '">Cancel</button>' +
        '</div></div>';
    } else {
      html += '<button class="popup-issue-option" data-act="askGone" data-fountain-id="' + local.id + '">' +
        '<span class="popup-ico">?</span>' +
        '<div class="popup-option-txt"><span class="popup-option-lbl">Gone or decommissioned</span>' +
        '<span class="popup-option-sub">Fixtures removed, or fountain no longer exists</span></div></button>';
    }

    return html;
  }

  function buildPopup(local) {
    if (!local) return '<div class="fountain-popup"><p>Data unavailable</p></div>';
    var state = getPopupState(local);
    var borderColor = POPUP_BORDER_COLORS[state];
    return '<div class="fountain-popup" data-fountain-id="' + local.id + '" style="border-left-color:' + borderColor + '">' +
      buildPopupMain(local) + '</div>';
  }

  function getPinZIndex(local) {
    var state = getPinStateForLocal(local);
    if (state === "unrated" && !(local && local.reported_off)) return 0;
    return 1000;
  }

  function pinStateToIcon(state, color) {
    if (state === "up")     return makeIcon(color, THUMB_UP);
    if (state === "down")   return makeIcon(color, THUMB_DOWN);
    if (state === "unrated") return makeIcon("#9e9e9e", QUESTION_ICON);
    return makeIcon(color, QUESTION_ICON);
  }

  function isReportedNotFound(local) {
    return local && local.not_found_count > 0;
  }

  function getCityIcon(local, sd) {
    if (isReportedNotFound(local)) return icons.reportedNotFound;
    if (local && local.reported_off) return icons.reportedOff;
    return pinStateToIcon(getPinStateForLocal(local), "#2563eb");
  }

  function getOsmIcon(local) {
    if (isReportedNotFound(local)) return icons.reportedNotFound;
    if (local && local.reported_off) return icons.reportedOff;
    var color = powerUserMode ? "#0891b2" : "#2563eb";
    return pinStateToIcon(getPinStateForLocal(local), color);
  }

  // fountainList is an array of fountain records from GET /fountains,
  // each having .id, .lat, .lon, .sources (with source_data), ratings, etc.
  var fountainList = [];

  function renderCity() {
    sources.city.layerGroup.clearLayers();
    fountainList.forEach(function (local) {
      var citySD = getSourceData(local, "city_gis");
      if (!citySD) return;
      if (!isCityRunning(citySD)) return;
      if (layerOptions.cityUniqueOnly && fountainHasOsmMatch(local)) return;
      if (activeFilters.accessible && !fountainHasAccessible(local)) return;
      if (activeFilters.bottle && !fountainHasBottle(local)) return;
      if (activeFilters.dog && !fountainHasDog(local)) return;
      if (!passesRatingFilter(local)) return;
      if (layerOptions.showNotFound) {
        if (local.not_found_count <= 0) return;
      } else if (local.not_found) return;

      var icon = layerOptions.showNotFound ? icons.reportedNotFound : getCityIcon(local, citySD);
      var cm = L.marker([local.lat, local.lon], { icon: icon, zIndexOffset: getPinZIndex(local) });
      cm._fountainId = local.id;
      cm.bindPopup(function () { return buildPopup(local); }, { className: "popup-v35", maxWidth: 320, minWidth: 300 }).addTo(sources.city.layerGroup);
    });
  }

  function renderOsm() {
    sources.osm.layerGroup.clearLayers();
    fountainList.forEach(function (local) {
      var osmSD = getSourceData(local, "osm");
      if (!osmSD) return;
      if (isCityShutOff(local)) return;
      if (!powerUserMode && fountainHasCityGisMatch(local)) return;
      if (activeFilters.accessible && !fountainHasAccessible(local)) return;
      if (activeFilters.bottle && !fountainHasBottle(local)) return;
      if (activeFilters.dog && !fountainHasDog(local)) return;
      if (!passesRatingFilter(local)) return;
      if (layerOptions.showNotFound) {
        if (local.not_found_count <= 0) return;
      } else if (local.not_found) return;

      var icon = layerOptions.showNotFound ? icons.reportedNotFound : getOsmIcon(local);
      var om = L.marker([local.lat, local.lon], { icon: icon, zIndexOffset: getPinZIndex(local) });
      om._fountainId = local.id;
      om.bindPopup(function () { return buildPopup(local); }, { className: "popup-v35", maxWidth: 320, minWidth: 300 }).addTo(sources.osm.layerGroup);
    });
  }

  function renderAll() {
    renderCity();
    renderOsm();
    updateCount();
  }

  function updateMarkerForFountain(fountainId) {
    var local = fountainIndex[fountainId];
    if (!local) return;
    var hasCityGis = fountainHasCityGisMatch(local);
    var hasOsm = (getSourceData(local, "osm") !== null);
    if (hasCityGis) {
      sources.city.layerGroup.eachLayer(function (marker) {
        if (marker._fountainId !== fountainId) return;
        marker.setIcon(getCityIcon(local, getSourceData(local, "city_gis")));
        marker.setZIndexOffset(getPinZIndex(local));
      });
    }
    if (hasOsm) {
      sources.osm.layerGroup.eachLayer(function (marker) {
        if (marker._fountainId !== fountainId) return;
        marker.setIcon(getOsmIcon(local));
        marker.setZIndexOffset(getPinZIndex(local));
      });
    }
  }

  function updateCount() {
    var bounds = map.getBounds();
    var count = 0;
    fountainList.forEach(function (local) {
      // Mirror renderCity / renderOsm visibility logic
      if (isCityShutOff(local)) return;
      if (layerOptions.showNotFound ? local.not_found_count <= 0 : local.not_found) return;
      if (activeFilters.accessible && !fountainHasAccessible(local)) return;
      if (activeFilters.bottle && !fountainHasBottle(local)) return;
      if (activeFilters.dog && !fountainHasDog(local)) return;
      if (!passesRatingFilter(local)) return;

      var hasCityGis = fountainHasCityGisMatch(local);
      var hasOsm = fountainHasOsmMatch(local);

      var visible = false;
      if (hasCityGis && sources.city.visible) {
        if (!layerOptions.cityUniqueOnly || !hasOsm) visible = true;
      }
      if (!visible && hasOsm && sources.osm.visible) {
        if (powerUserMode || !hasCityGis) visible = true;
      }
      if (!visible) return;

      if (bounds.contains(L.latLng(local.lat, local.lon))) count++;
    });
    var el = document.getElementById("fountain-count");
    el.textContent = count + " fountain" + (count !== 1 ? "s" : "") + " in view";
  }

  function fetchFountains() {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        fountainIndex = {};
        fountainList = data.fountains || [];
        fountainList.forEach(function (f) {
          fountainIndex[f.id] = f;
          (f.sources || []).forEach(function (s) {
            fountainIndex[s.source_type + ":" + s.source_id] = f;
          });
        });
        fountainIndexLoaded = true;
        updateRatingCounts();
        updateNotFoundCount();
        renderAll();
      })
      .catch(function (err) {
        console.error("Failed to fetch fountains:", err);
      });
  }

  var JSON_HEADERS = { "Content-Type": "application/json" };

  function submitAttribute(fountainId, attribute, value) {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains/" + fountainId + "/attributes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ device_id: deviceId, attribute: attribute, value: value }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Update failed: " + data.error);
          return;
        }
        var f = fountainIndex[fountainId];
        if (f) {
          f.user_accessible = data.user_accessible;
          f.user_bottle_filler = data.user_bottle_filler;
          f.user_dog_bowl = data.user_dog_bowl;
        }
      })
      .catch(function () {
        showError("Failed to update attribute. Please try again.");
      });
  }

  function submitReport(fountainId, status) {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains/" + fountainId + "/report", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ device_id: deviceId, status: status }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Report failed: " + data.error);
          return;
        }
        var f = fountainIndex[fountainId];
        if (f) {
          f.reported_off = data.reported_off;
          f.off_reports = data.off_reports;
          f.last_off_report_at = data.last_off_report_at;
        }
        refreshOpenPopup(fountainId);
        updateMarkerForFountain(fountainId);
      })
      .catch(function () {
        showError("Failed to submit report. Please try again.");
      });
  }

  function submitNotFound(fountainId, isAdminAction, forceAction) {
    if (!API_BASE) return;
    var isUndo = forceAction === "undo" ? true : forceAction === "add" ? false : (!isAdminAction && myNotFoundReports[fountainId]);
    var method = (isUndo || isAdminAction) ? "DELETE" : "POST";
    var body = isAdminAction
      ? { admin_token: adminToken }
      : { device_id: deviceId, clear_all: isUndo || undefined };
    fetch(API_BASE + "/fountains/" + fountainId + "/not-found", {
      method: method,
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Failed: " + data.error);
          return;
        }
        if (!isAdminAction) myNotFoundReports[fountainId] = data.your_report;
        var f = fountainIndex[fountainId];
        if (f) {
          f.not_found_count = data.not_found_count;
          f.not_found = data.not_found;
          f.last_not_found_at = data.last_not_found_at;
        }
        refreshOpenPopup(fountainId);
        updateMarkerForFountain(fountainId);
      })
      .catch(function () {
        showError("Failed to submit. Please try again.");
      });
  }

  function submitRating(fountainId, score) {
    if (!API_BASE) return;
    var isUnrating = myRatings[fountainId] === score;
    var method = isUnrating ? "DELETE" : "POST";
    fetch(API_BASE + "/fountains/" + fountainId + "/rating", {
      method: method,
      headers: JSON_HEADERS,
      body: JSON.stringify({ device_id: deviceId, score: score }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Rating failed: " + data.error);
          return;
        }
        myRatings[fountainId] = isUnrating ? null : score;
        var f = fountainIndex[fountainId];
        if (f) {
          f.thumbs_up = data.thumbs_up;
          f.thumbs_down = data.thumbs_down;
          f.rating_count = data.rating_count;
          f.last_rated_at = data.last_rated_at;
        }
        refreshOpenPopup(fountainId);
        updateMarkerForFountain(fountainId);
      })
      .catch(function () {
        showError("Failed to submit rating. Please try again.");
      });
  }

  function refreshOpenPopup(fountainId) {
    var el = document.querySelector('.fountain-popup[data-fountain-id="' + fountainId + '"]');
    if (!el) return;
    var local = fountainIndex[fountainId];
    if (!local) return;
    var state = getPopupState(local);
    el.style.borderLeftColor = POPUP_BORDER_COLORS[state];
    el.innerHTML = buildPopupMain(local);
    wirePopupEvents(el, local);
  }

  function swapPopupView(el, local, view, confirmStep) {
    el.innerHTML = view === "report" ? buildPopupReport(local, confirmStep) : buildPopupMain(local);
    wirePopupEvents(el, local);
  }

  function wirePopupEvents(container, local) {
    var fId = local.id;

    container.querySelectorAll("[data-vote]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        submitRating(fId, parseInt(this.dataset.vote));
      });
    });

    container.querySelectorAll(".popup-pill").forEach(function (pill) {
      pill.addEventListener("click", function (e) {
        e.stopPropagation();
        var attr = this.dataset.attribute;
        var isActive = this.classList.contains("active");
        submitAttribute(fId, attr, !isActive);
        this.classList.toggle("active");
      });
    });

    container.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = this.dataset.act;
        if (act === "openReport") {
          swapPopupView(container, local, "report", false);
        } else if (act === "backToMain") {
          swapPopupView(container, local, "main", false);
        } else if (act === "flowing") {
          submitReport(fId, "on");
        } else if (act === "confirmGone") {
          submitNotFound(fId, false, "add");
        } else if (act === "foundIt") {
          submitNotFound(fId, false, "undo");
        } else if (act === "reinstate") {
          submitNotFound(fId, true);
        } else if (act === "reportNoWater") {
          submitReport(fId, "off");
        } else if (act === "askGone") {
          swapPopupView(container, local, "report", true);
        } else if (act === "reportGone") {
          submitNotFound(fId, false, "add");
        } else if (act === "cancelGone") {
          swapPopupView(container, local, "report", false);
        }
      });
    });
  }

  map.on("popupopen", function (e) {
    var container = e.popup.getElement();
    if (!container) return;
    var el = container.querySelector(".fountain-popup");
    if (!el) return;
    var fId = parseInt(el.dataset.fountainId);
    var local = fountainIndex[fId];
    if (!local) return;
    wirePopupEvents(el, local);
  });

  function searchLocation(query) {
    var params = new URLSearchParams({
      q: query,
      format: "json",
      addressdetails: "1",
      limit: "1",
      viewbox: "-122.45,47.48,-122.24,47.73",
      bounded: "1",
    });

    return fetch(NOMINATIM_URL + "?" + params, {
      headers: { "Accept": "application/json" },
    })
      .then(function (res) { return res.json(); })
      .then(function (results) {
        if (results.length === 0) return null;
        return {
          lat: parseFloat(results[0].lat),
          lon: parseFloat(results[0].lon),
        };
      });
  }

  function showError(msg) {
    var existing = document.querySelector(".search-error");
    if (existing) existing.remove();

    var el = document.createElement("div");
    el.className = "search-error";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
  }

  function panToLocation(lat, lon) {
    map.setView([lat, lon], SEARCH_ZOOM);
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.circleMarker([lat, lon], {
      radius: 8,
      fillColor: "#4285f4",
      fillOpacity: 1,
      color: "#fff",
      weight: 2,
    }).addTo(map);
  }

  document.getElementById("search-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var query = document.getElementById("search-input").value.trim();
    if (!query) return;
    document.getElementById("search-input").blur();
    searchLocation(query).then(function (result) {
      if (!result) {
        showError("No results found in Seattle. Try a different search.");
        return;
      }
      panToLocation(result.lat, result.lon);
    }).catch(function () {
      showError("Search failed. Please try again.");
    });
  });

  var locating = false;

  function preloadLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function (pos) { cachedPosition = pos; },
      function (err) { if (err.code === 1) locationDenied = true; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  function locateUser() {
    if (locating) return;
    if (!navigator.geolocation) {
      showError("Geolocation is not supported by your browser.");
      return;
    }
    if (locationDenied) {
      showError("Location access denied. Check your browser or device settings.");
      return;
    }
    var cacheAgeSec = cachedPosition
      ? (Date.now() - cachedPosition.timestamp) / 1000
      : Infinity;
    if (cacheAgeSec < 60) {
      panToLocation(cachedPosition.coords.latitude, cachedPosition.coords.longitude);
      return;
    }
    locating = true;
    locateBtn.classList.add("locating");

    var watchId = navigator.geolocation.watchPosition(
      function (pos) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        cachedPosition = pos;
        panToLocation(pos.coords.latitude, pos.coords.longitude);
      },
      function (err) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        if (err.code === 1) {
          locationDenied = true;
          showError("Location access denied. Check your browser or device settings.");
        } else {
          showError("Unable to get your location. Try again.");
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  }

  // ─── Toolbar collapse / expand ────────────────────────────────

  var controlsBar = document.getElementById("controls-bar");
  var toolbarToggleBtn = document.getElementById("toolbar-toggle-btn");
  var toolbarCloseBtn = document.getElementById("toolbar-close-btn");

  function openToolbar() {
    controlsBar.classList.remove("collapsed");
    toolbarToggleBtn.classList.add("active");
  }

  function closeToolbar() {
    controlsBar.classList.add("collapsed");
    toolbarToggleBtn.classList.remove("active");
  }

  toolbarToggleBtn.addEventListener("click", function () {
    if (controlsBar.classList.contains("collapsed")) {
      openToolbar();
    } else {
      closeToolbar();
    }
  });

  toolbarCloseBtn.addEventListener("click", closeToolbar);

  // ─── Legend panel ──────────────────────────────────────────────

  var legendPanel = document.getElementById("legend-panel");
  var legendToggleBtn = document.getElementById("legend-toggle-btn");
  var legendPanelClose = document.getElementById("legend-panel-close");

  function openLegend() {
    legendPanel.classList.remove("hidden");
    legendToggleBtn.classList.add("active");
  }

  function closeLegend() {
    legendPanel.classList.add("hidden");
    legendToggleBtn.classList.remove("active");
  }

  legendToggleBtn.addEventListener("click", function () {
    if (legendPanel.classList.contains("hidden")) {
      openLegend();
    } else {
      closeLegend();
    }
  });

  legendPanelClose.addEventListener("click", closeLegend);

  // ─── Filter pills ──────────────────────────────────────────────

  document.querySelectorAll(".filter-pill").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      activeFilters[filter] = !activeFilters[filter];
      btn.classList.toggle("active");
      renderAll();
    });
  });

  var layerControl = document.getElementById("layer-control");
  var legendAdminRow = document.querySelector(".legend-admin-row");
  var confirmModal = document.getElementById("confirm-modal");
  var confirmMessage = document.getElementById("confirm-message");
  var confirmOkBtn = document.getElementById("confirm-ok-btn");
  var confirmCancelBtn = document.getElementById("confirm-cancel-btn");
  var confirmCallback = null;

  function showConfirm(message, onConfirm) {
    confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.remove("hidden");
  }

  function closeConfirm() {
    confirmModal.classList.add("hidden");
    confirmCallback = null;
  }

  confirmOkBtn.addEventListener("click", function () {
    var cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });
  confirmCancelBtn.addEventListener("click", closeConfirm);
  confirmModal.addEventListener("click", function (e) {
    if (e.target === confirmModal) closeConfirm();
  });

  var pinModal = document.getElementById("pin-modal");
  var pinInput = document.getElementById("pin-input");
  var pinError = document.getElementById("pin-error");
  var pinSubmitBtn = document.getElementById("pin-submit-btn");
  var pinCancelBtn = document.getElementById("pin-cancel-btn");

  var ADMIN_SESSION_KEY = "admin_unlocked";

  function isAdminUnlocked() {
    return sessionStorage.getItem(ADMIN_SESSION_KEY) === "1";
  }

  if (isAdminUnlocked()) {
    adminToken = sessionStorage.getItem("admin_token");
  }

  var menuDashboardLink = document.getElementById("menu-dashboard-link");

  function activateAdminMode() {
    powerUserMode = true;
    layerControl.classList.remove("hidden");
    legendAdminRow.classList.remove("hidden");
    menuDashboardLink.classList.remove("hidden");
    updateRatingCounts();
    renderAll();
  }

  if (isAdminUnlocked() && adminToken) {
    activateAdminMode();
  }

  function deactivateAdminMode() {
    powerUserMode = false;
    layerControl.classList.add("hidden");
    legendAdminRow.classList.add("hidden");
    menuDashboardLink.classList.add("hidden");
    if (layerOptions.ratingFilter) {
      layerOptions.ratingFilter = null;
      ratedBtn.classList.remove("active");
      unratedBtn.classList.remove("active");
      rated7dBtn.classList.remove("active");
    }
    if (layerOptions.showNotFound) {
      layerOptions.showNotFound = false;
      notFoundBtn.classList.remove("active");
    }
    renderAll();
  }

  function openPinModal() {
    pinInput.value = "";
    pinError.classList.add("hidden");
    pinModal.classList.remove("hidden");
    pinInput.focus();
  }

  function closePinModal() {
    pinModal.classList.add("hidden");
    pinInput.value = "";
    pinError.classList.add("hidden");
  }

  function submitPin() {
    var pin = pinInput.value.trim();
    if (!pin) return;
    pinSubmitBtn.disabled = true;
    pinSubmitBtn.textContent = "Checking…";
    fetch(API_BASE + "/admin/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin }),
    })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (r) {
        pinSubmitBtn.disabled = false;
        pinSubmitBtn.textContent = "Unlock";
        if (r.ok) {
          sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
          sessionStorage.setItem("admin_token", r.data.token);
          adminToken = r.data.token;
          closePinModal();
          activateAdminMode();
        } else {
          pinError.classList.remove("hidden");
          pinInput.value = "";
          pinInput.focus();
        }
      })
      .catch(function () {
        pinSubmitBtn.disabled = false;
        pinSubmitBtn.textContent = "Unlock";
        pinError.textContent = "Request failed. Try again.";
        pinError.classList.remove("hidden");
      });
  }

  pinSubmitBtn.addEventListener("click", submitPin);
  pinCancelBtn.addEventListener("click", closePinModal);
  pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPin();
    if (e.key === "Escape") closePinModal();
  });
  pinModal.addEventListener("click", function (e) {
    if (e.target === pinModal) closePinModal();
  });


  var cityUniqueBtn = document.querySelector('.layer-suboption[data-option="city-unique"]');
  var ratedBtn = document.querySelector('.layer-suboption[data-option="rated"]');
  var unratedBtn = document.querySelector('.layer-suboption[data-option="unrated"]');
  var rated7dBtn = document.querySelector('.layer-suboption[data-option="rated-7d"]');
  var countRatedEl = document.getElementById("count-rated");
  var countUnratedEl = document.getElementById("count-unrated");
  var countRated7dEl = document.getElementById("count-rated-7d");

  function updateRatingCounts() {
    if (!fountainIndexLoaded) return;
    var rated = 0, unrated = 0, rated7d = 0;
    var now = Date.now();
    fountainList.forEach(function (f) {
      if (hasUserContribution(f)) rated++; else unrated++;
      var ts7d = f.last_contributed_at || f.last_rated_at;
      if (ts7d && (now - new Date(ts7d).getTime()) < 7 * 86400000) rated7d++;
    });
    countRatedEl.textContent = rated;
    countUnratedEl.textContent = unrated;
    countRated7dEl.textContent = rated7d;
  }

  function setRatingFilter(option) {
    if (layerOptions.ratingFilter === option) {
      layerOptions.ratingFilter = null;
      ratedBtn.classList.remove("active");
      unratedBtn.classList.remove("active");
      rated7dBtn.classList.remove("active");
    } else {
      layerOptions.ratingFilter = option;
      ratedBtn.classList.toggle("active", option === "rated");
      unratedBtn.classList.toggle("active", option === "unrated");
      rated7dBtn.classList.toggle("active", option === "rated-7d");
    }
    renderAll();
  }

  ratedBtn.addEventListener("click", function () { setRatingFilter("rated"); });
  unratedBtn.addEventListener("click", function () { setRatingFilter("unrated"); });
  rated7dBtn.addEventListener("click", function () { setRatingFilter("rated-7d"); });

  var notFoundBtn = document.querySelector('.layer-suboption[data-option="not-found"]');
  var countNotFoundEl = document.getElementById("count-not-found");

  function updateNotFoundCount() {
    if (!fountainIndexLoaded || !countNotFoundEl) return;
    var count = 0;
    fountainList.forEach(function (f) { if (f.not_found_count > 0) count++; });
    countNotFoundEl.textContent = count;
  }

  notFoundBtn.addEventListener("click", function () {
    layerOptions.showNotFound = !layerOptions.showNotFound;
    notFoundBtn.classList.toggle("active", layerOptions.showNotFound);
    renderAll();
  });

  document.querySelectorAll(".layer-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var source = btn.dataset.source;
      var src = sources[source];
      src.visible = !src.visible;
      btn.classList.toggle("active");
      if (src.visible) {
        src.layerGroup.addTo(map);
      } else {
        map.removeLayer(src.layerGroup);
      }
      if (source === "city") {
        cityUniqueBtn.classList.toggle("hidden", !src.visible);
      }
      updateCount();
    });
  });

  cityUniqueBtn.addEventListener("click", function () {
    layerOptions.cityUniqueOnly = !layerOptions.cityUniqueOnly;
    cityUniqueBtn.classList.toggle("active");
    renderCity();
    updateCount();
  });

  map.on("moveend", updateCount);

  map.on("click", function () {
    closeLegend();
  });

  // ─── Hamburger menu ───────────────────────────────────────────

  var menuDrawer = document.getElementById("menu-drawer");
  var menuOverlay = document.getElementById("menu-overlay");
  var hamburgerBtn = document.getElementById("hamburger-btn");
  var menuCloseBtn = document.getElementById("menu-close-btn");

  function openMenu() {
    menuDrawer.classList.add("open");
    menuOverlay.classList.add("open");
  }

  function closeMenu() {
    menuDrawer.classList.remove("open");
    menuOverlay.classList.remove("open");
  }

  hamburgerBtn.addEventListener("click", openMenu);
  menuCloseBtn.addEventListener("click", closeMenu);
  menuOverlay.addEventListener("click", closeMenu);

  document.getElementById("feedback-btn").addEventListener("click", function () {
    window.open("https://tally.so/r/jag8Z9", "_blank", "noopener,noreferrer");
  });

  // ─── Content modal ─────────────────────────────────────────────

  var contentModal = document.getElementById("content-modal");
  var contentModalTitle = document.getElementById("content-modal-title");
  var contentModalBody = document.getElementById("content-modal-body");
  var contentModalClose = document.getElementById("content-modal-close");

  var MODAL_TITLES = {
    about:     "About Fountains For All",
    terms:     "Terms of Use",
    privacy:   "Privacy Policy",
    copyright: "Copyright",
  };

  var contentCache = {};

  var contentModalBox = document.getElementById("content-modal-box");

  function openContentModal(key) {
    var title = MODAL_TITLES[key];
    if (!title) return;
    contentModalTitle.textContent = title;
    contentModalBox.dataset.key = key;
    contentModalBody.scrollTop = 0;
    history.replaceState(null, "", "#" + key);
    if (contentCache[key]) {
      contentModalBody.innerHTML = contentCache[key];
      contentModal.classList.remove("hidden");
      return;
    }
    contentModalBody.innerHTML = '<p style="color:#aaa;font-size:14px">Loading…</p>';
    contentModal.classList.remove("hidden");
    fetch("page_content/" + key + ".html")
      .then(function (res) { return res.text(); })
      .then(function (html) {
        contentCache[key] = html;
        contentModalBody.innerHTML = html;
      })
      .catch(function () {
        contentModalBody.innerHTML = '<p style="color:#c62828">Failed to load content.</p>';
      });
  }

  function closeContentModal() {
    contentModal.classList.add("hidden");
    history.replaceState(null, "", location.pathname);
  }

  contentModalClose.addEventListener("click", closeContentModal);
  contentModal.addEventListener("click", function (e) {
    if (e.target === contentModal) closeContentModal();
  });

  document.querySelectorAll(".menu-item[data-modal]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeMenu();
      openContentModal(btn.dataset.modal);
    });
  });

  var initialHash = location.hash.replace("#", "");
  if (MODAL_TITLES[initialHash]) {
    openContentModal(initialHash);
  }

  var menuAdminBtn = document.getElementById("menu-admin-btn");
  menuAdminBtn.addEventListener("click", function () {
    closeMenu();
    if (powerUserMode) {
      deactivateAdminMode();
    } else if (isAdminUnlocked()) {
      activateAdminMode();
    } else {
      openPinModal();
    }
  });

  var WELCOME_DISMISSED_KEY = "welcome_dismissed";
  var welcomeModal = document.getElementById("welcome-modal");
  var welcomeModalBody = document.getElementById("welcome-modal-body");
  var welcomeModalClose = document.getElementById("welcome-modal-close");

  function closeWelcomeModal() {
    welcomeModal.classList.add("hidden");
    localStorage.setItem(WELCOME_DISMISSED_KEY, "1");
  }

  welcomeModalClose.addEventListener("click", closeWelcomeModal);
  welcomeModal.addEventListener("click", function (e) {
    if (e.target === welcomeModal) closeWelcomeModal();
  });

  if (!localStorage.getItem(WELCOME_DISMISSED_KEY)) {
    welcomeModal.classList.remove("hidden");
    fetch("page_content/welcome.html")
      .then(function (res) { return res.text(); })
      .then(function (html) {
        welcomeModalBody.innerHTML = html;
        var closeLink = document.getElementById("welcome-close-link");
        if (closeLink) closeLink.addEventListener("click", function (e) {
          e.preventDefault();
          closeWelcomeModal();
        });
      });
  }

  fetchFountains();
  preloadLocation();
})();
