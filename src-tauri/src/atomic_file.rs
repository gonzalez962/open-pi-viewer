use std::{io, path::Path};

#[cfg(test)]
thread_local! {
    pub(crate) static ATOMIC_JSON_RENAME_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path, &Path) -> io::Result<()>>>> = std::cell::RefCell::new(None);
}

fn rename(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(test)]
    if let Some(result) = ATOMIC_JSON_RENAME_HOOK.with(|hook| {
        hook.borrow_mut().as_mut().map(|rename| rename(from, to))
    }) {
        return result;
    }
    std::fs::rename(from, to)
}

/// Replace a staged file without ever moving or deleting the destination first.
pub(crate) fn replace(from: &Path, to: &Path) -> io::Result<()> {
    const MAX_ATTEMPTS: usize = 5;
    for attempt in 1..=MAX_ATTEMPTS {
        match rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                // In tests, an installed hook explicitly simulates Windows errors on any host.
                #[cfg(test)]
                let windows = cfg!(windows) || ATOMIC_JSON_RENAME_HOOK.with(|hook| hook.borrow().is_some());
                #[cfg(not(test))]
                let windows = cfg!(windows);
                let retry = windows && matches!(error.raw_os_error(), Some(5 | 32 | 33));
                if !retry || attempt == MAX_ATTEMPTS {
                    let _ = std::fs::remove_file(from);
                    return Err(error);
                }
                std::thread::sleep(std::time::Duration::from_millis(10 * attempt as u64));
            }
        }
    }
    unreachable!()
}
