- An experimental Linux VM profile's window no longer stops at "Profile changed" once its VM is
  up: the backend in the VM now reports the profile it serves. Profiles can't be created,
  changed or deleted from inside a VM profile; manage them from a host profile.
