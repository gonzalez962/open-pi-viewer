use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Listener, Manager,
};

const TRAY_ID: &str = "pi-viewer-background";

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show() {
            eprintln!("Unable to show Pi Viewer: {error}");
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn available(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Pi Viewer", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit Pi Viewer", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Application icon unavailable for system tray",
        ))
    })?;
    let colors = [
        [63, 185, 80, 255],
        [31, 111, 235, 255],
        [210, 153, 34, 255],
        [248, 81, 73, 255],
    ];
    let icons: Vec<_> = colors
        .iter()
        .map(|color| {
            tauri::image::Image::new_owned(
                crate::tray_activity::dotted_rgba(icon.rgba(), icon.width(), icon.height(), *color),
                icon.width(),
                icon.height(),
            )
        })
        .collect();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icons[0].clone())
        .tooltip("Pi Viewer — sessions continue in the background")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            // ExitRequested retains the existing bounded asynchronous process cleanup.
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    let activity = std::sync::Arc::new(std::sync::Mutex::new(
        crate::tray_activity::Activity::default(),
    ));
    let (updates, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    for channel in ["pi://event", "pi://status-change", "pi://error"] {
        let activity = activity.clone();
        let updates = updates.clone();
        app.listen(channel, move |event| {
            let Ok(payload) = serde_json::from_str(event.payload()) else {
                return;
            };
            let Ok(mut state) = activity.lock() else {
                return;
            };
            if state.update(channel, &payload) {
                let _ = updates.send(());
            }
        });
    }
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let mut amber_phase = false;
        let mut last_color = colors[0];
        loop {
            let animate = activity
                .lock()
                .map(|state| state.color(false) == colors[1])
                .unwrap_or(false);
            if animate {
                tokio::select! {
                    update = receiver.recv() => { if update.is_none() { break; } amber_phase = false; }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(800)) => { amber_phase = !amber_phase; }
                }
            } else {
                if receiver.recv().await.is_none() {
                    break;
                }
                amber_phase = false;
            }
            let color = match activity.lock() {
                Ok(state) => state.color(amber_phase),
                Err(_) => break,
            };
            if color != last_color {
                let Some(tray) = handle.tray_by_id(TRAY_ID) else {
                    break;
                };
                let index = colors.iter().position(|value| *value == color).unwrap_or(0);
                if let Err(error) = tray.set_icon(Some(icons[index].clone())) {
                    eprintln!("Unable to update tray activity: {error}");
                } else {
                    last_color = color;
                }
            }
        }
    });
    Ok(())
}
