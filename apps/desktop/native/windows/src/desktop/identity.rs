use super::*;

pub(super) fn browser(id: &str) -> bool {
    let name = id.rsplit(['\\', '/']).next().unwrap_or(id);
    [
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "arc.exe",
    ]
    .contains(&name)
}
pub(super) unsafe fn class(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buffer);
    String::from_utf16_lossy(&buffer[..len.max(0) as usize]).to_lowercase()
}
pub(super) unsafe fn pid(hwnd: HWND) -> u32 {
    let mut id = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut id));
    id
}
pub(super) unsafe extern "system" fn child_owner(hwnd: HWND, data: LPARAM) -> BOOL {
    if class(hwnd) == "windows.ui.core.corewindow" {
        *(data.0 as *mut u32) = pid(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}
pub(super) unsafe fn owner(hwnd: HWND) -> Result<(String, u32), Value> {
    let mut process_id = pid(hwnd);
    let mut process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| blocked("owner-unknown"))?;
    let mut path = [0u16; 32768];
    let mut size = path.len() as u32;
    let path_ok = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()),
        &mut size,
    )
    .is_ok();
    let _ = CloseHandle(process);
    if !path_ok {
        return Err(blocked("owner-unknown"));
    }
    let exe = String::from_utf16_lossy(&path[..size as usize]).to_lowercase();
    if exe.ends_with("\\applicationframehost.exe") {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(child_owner),
            LPARAM(&mut process_id as *mut u32 as isize),
        );
        if process_id == pid(hwnd) {
            return Err(blocked("owner-unknown"));
        }
        process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|_| blocked("owner-unknown"))?;
    } else {
        process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|_| blocked("owner-unknown"))?;
    }
    let mut length = 0;
    let status = GetApplicationUserModelId(process, &mut length, None);
    let mut aumid = vec![0u16; length as usize];
    let id = if status == ERROR_INSUFFICIENT_BUFFER
        && length > 0
        && GetApplicationUserModelId(process, &mut length, Some(PWSTR(aumid.as_mut_ptr())))
            == ERROR_SUCCESS
    {
        String::from_utf16_lossy(&aumid[..length.saturating_sub(1) as usize]).to_lowercase()
    } else {
        exe
    };
    let _ = CloseHandle(process);
    Ok((id, process_id))
}
pub(super) unsafe fn process_image(process_id: u32) -> Result<String, Value> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| blocked("owner-unknown"))?;
    let mut path = [0u16; 32768];
    let mut size = path.len() as u32;
    let result = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(process);
    result.map_err(|_| blocked("owner-unknown"))?;
    Ok(String::from_utf16_lossy(&path[..size as usize]).to_lowercase())
}
pub(super) unsafe fn process_started(process_id: u32) -> Result<u64, Value> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| fail("StaleElement"))?;
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    let result = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
    let _ = CloseHandle(process);
    result.map_err(|_| fail("StaleElement"))?;
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}
pub(super) unsafe fn integrity(process_id: u32) -> Result<u32, Value> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| blocked("protection-unknown"))?;
    let mut token = HANDLE::default();
    let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
    let _ = CloseHandle(process);
    opened.map_err(|_| blocked("protection-unknown"))?;
    let mut needed = 0;
    let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
    let mut storage = vec![0usize; (needed as usize + 7) / 8];
    let status = GetTokenInformation(
        token,
        TokenIntegrityLevel,
        Some(storage.as_mut_ptr() as *mut _),
        needed,
        &mut needed,
    );
    if status.is_err() {
        let _ = CloseHandle(token);
        return Err(blocked("protection-unknown"));
    }
    let label = &*(storage.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let count = *GetSidSubAuthorityCount(label.Label.Sid);
    let level = *GetSidSubAuthority(label.Label.Sid, count.saturating_sub(1) as u32);
    let _ = CloseHandle(token);
    Ok(level)
}
pub(super) unsafe fn apps() -> Vec<Value> {
    let mut unique = HashMap::new();
    for hwnd in windows() {
        if !IsWindowVisible(hwnd).as_bool() {
            continue;
        }
        if let Ok((id, process_id)) = owner(hwnd) {
            let identity_tier = app_tier(&id);
            let executable = process_image(process_id);
            let executable_tier = executable
                .as_ref()
                .map(|exe| app_tier(exe))
                .unwrap_or_else(|_| "blocked".into());
            let tier = crate::safety::restrict_tier(&identity_tier, &executable_tier);
            let name = id.rsplit(['\\', '/']).next().unwrap_or(&id).to_string();
            let frontmost = hwnd == GetForegroundWindow();
            unique.entry(id.clone())
                .and_modify(|app: &mut Value| {
                    if frontmost {
                        app["frontmost"] = json!(true);
                    }
                })
                .or_insert(json!({"appId":id,"name":name,"running":true,"frontmost":frontmost,"tier":tier,"warning":if browser(&id) || executable.as_ref().map(|exe|browser(exe)).unwrap_or(false){json!("browser")}else{Value::Null}}));
        }
    }
    unique
        .into_values()
        .map(|mut value| {
            if value["warning"].is_null() {
                value.as_object_mut().unwrap().remove("warning");
            }
            value
        })
        .collect()
}
pub(super) unsafe fn resolve_installed(host: &Value) -> Vec<Value> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let mut records: HashMap<String, Value> = apps()
        .into_iter()
        .map(|app| (s(&app, "appId").to_string(), app))
        .collect();
    let mut paths = Vec::new();
    fn links(dir: &std::path::Path, depth: usize, output: &mut Vec<std::path::PathBuf>) {
        if depth > 8 || output.len() >= 5000 {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    links(&path, depth + 1, output);
                } else if path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("lnk"))
                    .unwrap_or(false)
                {
                    output.push(path);
                }
            }
        }
    }
    for env in ["ProgramData", "AppData"] {
        if let Ok(root) = std::env::var(env) {
            links(
                &std::path::Path::new(&root).join("Microsoft/Windows/Start Menu/Programs"),
                0,
                &mut paths,
            );
        }
    }
    for path in paths {
        let Ok(link) = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER)
        else {
            continue;
        };
        let Ok(file) = link.cast::<IPersistFile>() else {
            continue;
        };
        let path_wide = wide(&path.to_string_lossy());
        if file.Load(PCWSTR(path_wide.as_ptr()), STGM_READ).is_err() {
            continue;
        }
        let mut target = [0u16; 32768];
        if link
            .GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .is_err()
        {
            continue;
        }
        let end = target
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(target.len());
        let target = String::from_utf16_lossy(&target[..end]);
        if !std::path::Path::new(&target).is_absolute() || !target.to_lowercase().ends_with(".exe")
        {
            continue;
        }
        let id = target.to_lowercase();
        STATE
            .get()
            .unwrap()
            .installed
            .lock()
            .unwrap()
            .insert(id.clone(), target);
        records.entry(id.clone()).or_insert(json!({"appId":id,"name":path.file_stem().unwrap_or_default().to_string_lossy(),"running":false,"frontmost":false,"tier":app_tier(&id)}));
    }
    let folder_name = wide("shell:AppsFolder");
    if let Ok(folder) =
        SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(folder_name.as_ptr()), None)
    {
        if let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) {
            for _ in 0..5000 {
                let mut item = [None];
                let mut fetched = 0;
                if items.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                    break;
                }
                let Some(item) = item[0].take() else { break };
                if let Ok(raw) = item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) {
                    let id = raw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(raw.0 as _));
                    let id = id.rsplit('\\').next().unwrap_or(&id).to_string();
                    if !id.contains('!') {
                        continue;
                    }
                    let name = item
                        .GetDisplayName(SIGDN_NORMALDISPLAY)
                        .map(|raw| {
                            let value = raw.to_string().unwrap_or_default();
                            CoTaskMemFree(Some(raw.0 as _));
                            value
                        })
                        .unwrap_or_else(|_| id.clone());
                    STATE
                        .get()
                        .unwrap()
                        .installed
                        .lock()
                        .unwrap()
                        .insert(id.to_lowercase(), id.clone());
                    let id = id.to_lowercase();
                    records.entry(id.clone()).or_insert(json!({"appId":id,"name":name,"running":false,"frontmost":false,"tier":app_tier(&id)}));
                }
            }
        }
    }
    let f5: HashSet<String> = windows()
        .into_iter()
        .filter_map(|hwnd| owner(hwnd).ok())
        .filter(|(_, pid)| {
            host["f5Pids"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|entry| entry.as_u64() == Some(*pid as u64))
        })
        .map(|(id, _)| id)
        .collect();
    records
        .into_values()
        .map(|mut record| {
            if f5.contains(s(&record, "appId")) {
                record["tier"] = json!("blocked");
            }
            if browser(s(&record, "appId")) {
                record["warning"] = json!("browser");
            }
            record
        })
        .collect()
}
pub(super) unsafe fn open_app(request: &Value, host: &Value) -> Result<(), Value> {
    check(request)?;
    let id = s(request, "appId");
    let tier = app_tier(id);
    if tier == "blocked" {
        return Err(blocked("protection-unknown"));
    }
    let granted = request["authorization"]["grants"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|grant| {
            s(grant, "appId") == id
                && s(grant, "tier") == tier
                && ["click", "full"].contains(&tier.as_str())
        });
    if !granted {
        return Err(json!({"_tag":"NotGranted","needed":"click"}));
    }
    resolve_installed(host);
    let target = STATE
        .get()
        .unwrap()
        .installed
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or(fail("UnsupportedAction"))?;
    let f5_path = s(host, "f5BundlePath").to_lowercase();
    if !f5_path.is_empty() && target.to_lowercase().starts_with(&f5_path) {
        return Err(blocked("f5"));
    }
    check(request)?;
    let name = wide(&target);
    mark_posted();
    if target.contains('!') {
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)
                .map_err(|_| fail("UnsupportedAction"))?;
        manager
            .ActivateApplication(PCWSTR(name.as_ptr()), PCWSTR::null(), AO_NONE)
            .map_err(|_| fail("Execution"))?;
    } else if ShellExecuteW(
        None,
        w!("open"),
        PCWSTR(name.as_ptr()),
        PCWSTR::null(),
        PCWSTR::null(),
        SW_SHOWNORMAL,
    )
    .0 as usize
        <= 32
    {
        return Err(fail("Execution"));
    }
    Ok(())
}
