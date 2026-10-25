// popup.js

// Setup the UI
console.log("Popup UI setup begin")
const setupContainer = document.getElementById("setup-container");
const outputContainer = document.getElementById("output-container");
const developerContainer = document.getElementById("developer-container");

chrome.runtime.sendMessage({message: "getOptions"}, function(options) {
  // Run every time the popup is shown.
  if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      return;
  }

  if (options.setup_toggle) {
      setupContainer.style.display = 'none';
      outputContainer.style.display = 'block';
      developerContainer.style.display = 'none';
  } else {
      setupContainer.style.display = 'block';
      outputContainer.style.display = 'none';
      developerContainer.style.display = 'none';
      if (options.debug_mode_toggle) {
        developerContainer.style.display = 'block';
      }
    }
});
console.log("Popup UI setup end")

// Send a message to the extension with a callback which in turn updates the popup content using
// the reponse from the listener in background.js.
// We'll use this to update the window once the wanted token is found.
chrome.runtime.sendMessage({message: "getToken"}, function(response) {
    // Run every time the popup is shown.
    if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        return;
    }
    if (response && response.token) {
        document.getElementById("token-url").innerText = "URL: " + response.url;
        document.getElementById("output-token").value = response.token;

        // Developer mode thing - add "Bearer" or not
        chrome.runtime.sendMessage({message: "getOptions"}, function(response) {
           if(response.include_bearer_toggle) {
              const element = document.getElementById("output-token");
              element.value = "Bearer "+element.value;
           }
        });
    } else {
        document.getElementById("output-token").value = "No Bearer token found.";
    }
});

const webhookButton = document.getElementById("ha-button");
webhookButton.addEventListener("click", () => {
    webhookButton.disabled = true;
    showNotification("Sending token to Home Assistant...");
    // Send the token to the HA instance defined by having "developer mode" on or off
    chrome.runtime.sendMessage({message: "getOptions"}, function(options) {
        if (chrome.runtime.lastError || !options) {
            showNotification("Could not load Home Assistant settings.", true);
            webhookButton.disabled = false;
            return;
        }
        chrome.runtime.sendMessage({message: "getToken"}, function(response) {
            if (chrome.runtime.lastError || !response || !response.token ||
                !Number.isFinite(response.expiresAt) || response.expiresAt <= Date.now()) {
                showNotification("No valid Novafos token. Log in to Novafos again.", true);
                document.getElementById("output-token").value = "No valid Bearer token found.";
                document.getElementById("token-url").innerText = "";
                webhookButton.disabled = false;
                return;
            }
            if(options.debug_mode_toggle) {
                // Use DEV configuration instead
                callHomeAssistantService(options.ha_url_dev, options.ha_token_dev, response.token, response.expiresAt)
            } else {
                // Use normal config
                callHomeAssistantService(options.ha_url, options.ha_token, response.token, response.expiresAt)
            }
        });
    });
});

function showNotification(message, warning = false) {
    const notificationContainer = document.getElementById("notification-container");
    notificationContainer.className = warning ? "uk-text-warning" : "uk-text-success";
    notificationContainer.textContent = message;
}

async function callHomeAssistantService(ha_url, ha_token, access_token, expiresAt) {
  // Call this function to access the HA Novafox update token action service.
  // Using a Service/custom action:
  // Docs:
  // https://developers.home-assistant.io/docs/api/rest/
  // https://developers.home-assistant.io/docs/dev_101_services/
  // Example: 
  //   https://github.com/phanmemkhoinghiep/homeassistant/blob/0ee37638cb05ae6c6ae0aa7522d51adf042cf487/custom_components/tts_ggcloud/__init__.py#L30
  const data = {
    access_token: access_token
  };

  let headers = new Headers();
  headers.append('Content-Type', 'application/json');
  headers.append('Accept', 'application/json');
  headers.append('Authorization', 'Bearer ' + ha_token);

    try {
        if (!access_token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            throw new Error("Novafos token expired. Log in to Novafos again.");
        }
        const response = await fetch(ha_url + "/api/services/novafos/update_token", {
      mode: 'cors',
      method: 'POST',
      headers: headers,
      body: JSON.stringify(data)
        });
        if (!response.ok) {
            throw new Error("Home Assistant returned HTTP " + response.status + ".");
        }
        showNotification("Token sent to Home Assistant.");
    } catch (error) {
        showNotification("Something went wrong: " + error.message, true);
    } finally {
        webhookButton.disabled = false;
    }
}
