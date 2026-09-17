//! Version-one vault format: salt || nonce || ciphertext with appended GCM tag.
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

pub fn derive(secret: &str, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(19456, 2, 1, Some(32)).map_err(|_| "Invalid vault parameters")?;
    let mut key = Zeroizing::new([0; 32]);
    let mut memory = Zeroizing::new(vec![argon2::Block::default(); params.block_count()]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(
            secret.as_bytes(),
            salt,
            key.as_mut(),
            memory.as_mut_slice(),
        )
        .map_err(|_| "Cannot derive vault key")?;
    Ok(key)
}
pub fn salt() -> [u8; 16] {
    let mut salt = [0; 16];
    OsRng.fill_bytes(&mut salt);
    salt
}
pub fn encrypt(data: &[u8], key: &[u8; 32], salt: &[u8; 16]) -> Result<Vec<u8>, String> {
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid vault key")?;
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), data)
        .map_err(|_| "Cannot encrypt vault")?;
    let mut blob = Vec::with_capacity(28 + encrypted.len());
    blob.extend_from_slice(salt);
    blob.extend_from_slice(&nonce);
    blob.extend(encrypted);
    Ok(blob)
}
pub fn decrypt(blob: &[u8], key: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>, String> {
    if blob.len() < 44 {
        return Err("Cannot unlock vault".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Cannot unlock vault")?;
    cipher
        .decrypt(Nonce::from_slice(&blob[16..28]), &blob[28..])
        .map(Zeroizing::new)
        .map_err(|_| "Cannot unlock vault".into())
}
