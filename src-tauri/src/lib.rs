use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tauri::ipc::Response;

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(metadata.len())
}

#[tauri::command]
fn read_file_chunk(path: String, offset: u64, size: u32) -> Result<Response, String> {
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buffer = vec![0; size as usize];
    let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(bytes_read);
    Ok(Response::new(buffer))
}

/// Read an entire file at once — faster for files under ~500 MB
#[tauri::command]
fn read_file_all(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_file_size, read_file_chunk, read_file_all])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
