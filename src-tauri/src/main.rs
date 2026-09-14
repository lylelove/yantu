// Prevent a second console window from appearing alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Yantu desktop shell.
//!
//! The game logic, the save file and the OpenAlex client all live in the
//! frontend, so this process deliberately exposes no commands: there is no IPC
//! surface to get wrong, and nothing here can reach the user's files. Tauri's
//! job is to host the window and enforce the content-security policy declared
//! in `tauri.conf.json`.
//!
//! If a future version moves the library into SQLite for larger corpora, this
//! is where those commands would be registered.

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiProxyRequest {
    url: String,
    method: String,
    headers: Vec<Vec<String>>,
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProxyResponse {
    status: u16,
    body: String,
}

/// Proxy an AI API call through the Tauri backend to bypass browser CORS
/// restrictions. Used when the user configures a custom AI endpoint that
/// does not return CORS headers.
#[tauri::command]
async fn ai_proxy(request: AiProxyRequest) -> Result<AiProxyResponse, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut req = match request.method.to_uppercase().as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        _ => return Err(format!("Unsupported HTTP method: {}", request.method)),
    };

    for header in &request.headers {
        if header.len() == 2 {
            req = req.header(&header[0], &header[1]);
        }
    }

    if let Some(body) = &request.body {
        req = req.body(body.clone());
    }

    let response = req.send().await.map_err(|e| format!("HTTP request failed: {}", e))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok(AiProxyResponse { status, body })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ai_proxy])
        .run(tauri::generate_context!())
        .expect("error while running Yantu");
}
