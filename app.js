(function () {
  "use strict";

  const ARCGIS_URL =
    "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Drinking_Fountain/FeatureServer/0/query";
  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  const SEATTLE_CENTER = [47.6062, -122.3321];
  const SEATTLE_BOUNDS = "47.3,-122.5,47.8,-122.2";
  const DEFAULT_ZOOM = 13;
  const SEARCH_ZOOM = 16;

  const map = L.map("map", {
    center: SEATTLE_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  let userMarker = null;

  const activeFilters = {
    running: false,
    accessible: false,
  };

  const sources = {
    city: { layerGroup: L.layerGroup().addTo(map), data: [], visible: true },
    osm:  { layerGroup: L.layerGroup().addTo(map), data: [], visible: true },
  };

  function isYes(val) {
    return typeof val === "string" && val.toUpperCase() === "YES";
  }

  function isCityRunning(f) {
    return f.CURRENT_STATUS === "ON" || f.CURRENT_STATUS === null || f.CURRENT_STATUS === undefined;
  }

  function makeIcon(color) {
    return L.divIcon({
      className: "fountain-marker",
      html: `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
        <path d="M14 7c0 0-5 5.5-5 9a5 5 0 0 0 10 0c0-3.5-5-9-5-9z" fill="#fff" opacity="0.9"/>
      </svg>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -30],
    });
  }

  const icons = {
    cityOn:  makeIcon("#2563eb"),
    cityOff: makeIcon("#c62828"),
    osm:     makeIcon("#0891b2"),
  };

  function buildCityPopup(f) {
    const running = isCityRunning(f);
    let details = "";
    if (isYes(f.ACCESSIBLE_MODEL))
      details += `<div><span class="detail-label">Accessible:</span> Yes</div>`;
    if (!running)
      details += `<div><span class="detail-label">Reason Off:</span> ${f.REASON_OFF || "UNKNOWN"}</div>`;
    details += `<div class="popup-source">Seattle City GIS</div>`;

    return `<div class="fountain-popup">
      <h3>${f.PARK || "Drinking Fountain"}</h3>
      ${running ? "" : '<span class="status off">Shut Off</span>'}
      <div class="details">${details}</div>
    </div>`;
  }

  function buildOsmPopup(el) {
    const tags = el.tags || {};
    let details = "";
    if (tags.wheelchair === "yes")
      details += `<div><span class="detail-label">Accessible:</span> Yes</div>`;
    if (tags.bottle === "yes")
      details += `<div><span class="detail-label">Bottle Filler:</span> Yes</div>`;
    if (tags.check_date)
      details += `<div><span class="detail-label">Last Verified:</span> ${tags.check_date}</div>`;
    details += `<div class="popup-source">OpenStreetMap</div>`;

    return `<div class="fountain-popup">
      <h3>${tags.name || "Drinking Fountain"}</h3>
      <div class="details">${details}</div>
    </div>`;
  }

  function renderCity() {
    sources.city.layerGroup.clearLayers();
    sources.city.data.forEach(function (f) {
      if (f.LIFE_CYCLE_CODE !== "A") return;
      if (activeFilters.running && !isCityRunning(f)) return;
      if (activeFilters.accessible && !isYes(f.ACCESSIBLE_MODEL)) return;

      const icon = isCityRunning(f) ? icons.cityOn : icons.cityOff;
      L.marker([f.LATITUDE, f.LONGITUDE], { icon: icon })
        .bindPopup(buildCityPopup(f))
        .addTo(sources.city.layerGroup);
    });
  }

  function renderOsm() {
    sources.osm.layerGroup.clearLayers();
    sources.osm.data.forEach(function (el) {
      if (activeFilters.accessible && el.tags.wheelchair !== "yes") return;

      L.marker([el.lat, el.lon], { icon: icons.osm })
        .bindPopup(buildOsmPopup(el))
        .addTo(sources.osm.layerGroup);
    });
  }

  function renderAll() {
    renderCity();
    renderOsm();
    updateCount();
  }

  function updateCount() {
    var bounds = map.getBounds();
    var count = 0;
    Object.values(sources).forEach(function (src) {
      if (!src.visible) return;
      src.layerGroup.eachLayer(function (marker) {
        if (bounds.contains(marker.getLatLng())) count++;
      });
    });
    var el = document.getElementById("fountain-count");
    el.textContent = count + " fountain" + (count !== 1 ? "s" : "") + " in view";
  }

  function fetchCity() {
    const params = new URLSearchParams({
      where: "1=1",
      outFields: [
        "OBJECTID", "PARK", "ACCESSIBLE_MODEL", "CURRENT_STATUS",
        "REASON_OFF", "LATITUDE", "LONGITUDE", "LIFE_CYCLE_CODE",
      ].join(","),
      f: "json",
      resultRecordCount: 2000,
    });

    fetch(ARCGIS_URL + "?" + params)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.features) return;
        sources.city.data = data.features.map(function (f) { return f.attributes; });
        renderCity();
        updateCount();
      })
      .catch(function (err) { console.error("Failed to fetch City GIS data:", err); });
  }

  function fetchOsm() {
    const query = `[out:json];node[amenity=drinking_water](${SEATTLE_BOUNDS});out body;`;
    fetch(OVERPASS_URL, { method: "POST", body: query })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        sources.osm.data = data.elements || [];
        renderOsm();
        updateCount();
      })
      .catch(function (err) { console.error("Failed to fetch OSM data:", err); });
  }

  function searchLocation(query) {
    const params = new URLSearchParams({
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

  // Search
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

  // Geolocation
  var locateBtn = document.getElementById("locate-btn");
  var locating = false;

  function locateUser() {
    if (locating) return;
    if (!navigator.geolocation) {
      showError("Geolocation is not supported by your browser.");
      return;
    }
    locating = true;
    locateBtn.classList.add("locating");

    var watchId = navigator.geolocation.watchPosition(
      function (pos) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        panToLocation(pos.coords.latitude, pos.coords.longitude);
      },
      function (err) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        if (err.code === 1) {
          showError("Location access denied. Check your browser permissions.");
        } else {
          showError("Unable to get your location. Try again.");
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  }

  locateBtn.addEventListener("click", locateUser);

  // Filters
  document.querySelectorAll(".filter-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      activeFilters[filter] = !activeFilters[filter];
      btn.classList.toggle("active");
      renderAll();
    });
  });

  // Layer toggles
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
      updateCount();
    });
  });

  map.on("moveend", updateCount);

  fetchCity();
  fetchOsm();
})();
