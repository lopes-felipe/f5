fn main() {
    #[cfg(windows)]
    embed_resource::compile("helper.rc", embed_resource::NONE)
        .manifest_required()
        .unwrap();
}
