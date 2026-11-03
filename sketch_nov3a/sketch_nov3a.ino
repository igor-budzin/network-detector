#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "secrets.h"

const int ledPin = 2;
const int ledBrightness = 102;  // 0 (off) to 255 (full brightness); 102 is 40%
const unsigned long connectTimeoutMs = 20000;
const unsigned long retryDelayMs = 5000;

const IPAddress iphoneIp(IPHONE_IP);
const uint16_t iphonePort = 62078;  // iOS devices listen on this port
const int32_t iphoneTimeoutMs = 3000;
const unsigned long checkIntervalMs = 30000;
const unsigned long iphoneAwayAfterMs = 300000;  // a locked iPhone can miss checks while its Wi-Fi sleeps

const unsigned long heartbeatIntervalMs = 10000;  // the server reports an outage after 30 s of silence
const uint16_t heartbeatTimeoutMs = 5000;

unsigned long lastCheckAt = 0;
unsigned long lastHeartbeatAt = 0;
bool iphoneEverSeen = false;
unsigned long lastIphoneSeenAt = 0;

void flashLed(int times) {
  for (int i = 0; i < times; i++) {
    analogWrite(ledPin, ledBrightness);
    delay(200);
    analogWrite(ledPin, 0);
    delay(200);
  }
}

bool connectToWiFi() {
  Serial.printf("Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < connectTimeoutMs) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  return WiFi.status() == WL_CONNECTED;
}

bool isIphoneOnNetwork() {
  WiFiClient client;
  bool found = client.connect(iphoneIp, iphonePort, iphoneTimeoutMs);
  client.stop();
  return found;
}

bool isIphoneHome() {
  return iphoneEverSeen && millis() - lastIphoneSeenAt < iphoneAwayAfterMs;
}

void sendHeartbeat() {
  WiFiClientSecure client;
  client.setInsecure();  // skips certificate validation, so there is no certificate to keep updated
  HTTPClient http;
  if (!http.begin(client, SERVER_URL)) {
    Serial.println("Heartbeat failed: invalid SERVER_URL");
    return;
  }
  http.setTimeout(heartbeatTimeoutMs);
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  http.addHeader("X-Iphone-Home", isIphoneHome() ? "1" : "0");
  int code = http.POST("");  // negative codes are connection errors
  Serial.printf("Heartbeat: %d\n", code);
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
  analogWrite(ledPin, 0);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // loop() handles reconnecting, so a new connection also flashes the LED
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    // The iPhone check runs first so the first heartbeat after connecting reports it.
    if (millis() - lastCheckAt >= checkIntervalMs) {
      lastCheckAt = millis();
      if (isIphoneOnNetwork()) {
        iphoneEverSeen = true;
        lastIphoneSeenAt = millis();
        Serial.println("iPhone found");
        flashLed(2);
      } else {
        Serial.println("iPhone not found");
      }
    }
    if (millis() - lastHeartbeatAt >= heartbeatIntervalMs) {
      lastHeartbeatAt = millis();
      sendHeartbeat();
    }
    delay(100);
    return;
  }

  if (connectToWiFi()) {
    Serial.print("Connected. IP address: ");
    Serial.println(WiFi.localIP());
    flashLed(3);
    delay(1000);  // keeps the 3 connection flashes separate from the first iPhone check
    lastCheckAt = millis() - checkIntervalMs;  // check right away after connecting
    lastHeartbeatAt = millis() - heartbeatIntervalMs;  // and report to the server right away
  } else {
    // Status 1 means the network wasn't found (wrong name, out of range, or 5 GHz only)
    Serial.printf("Connection failed (status %d). Retrying in %lu seconds.\n", WiFi.status(), retryDelayMs / 1000);
    WiFi.disconnect();
    delay(retryDelayMs);
  }
}
