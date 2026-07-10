use regex::{Captures, Regex};

const REDACTED: &str = "<redacted>";

#[must_use]
pub fn redact_text(input: &str) -> String {
    let private_key =
        Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
            .expect("private key regex");
    let bearer =
        Regex::new(r#"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s\"']+"#).expect("bearer regex");
    let user_info = Regex::new(r"(https?://[^\s:/@]+:)([^\s@/]+)(@)").expect("userinfo regex");

    let output = private_key.replace_all(input, REDACTED);
    let output = output
        .split_inclusive('\n')
        .map(redact_assignment_line)
        .collect::<String>();
    let output = bearer.replace_all(&output, |captures: &Captures<'_>| {
        format!("{}{}", &captures[1], REDACTED)
    });
    user_info
        .replace_all(&output, |captures: &Captures<'_>| {
            if safe_placeholder(&captures[2]) {
                captures[0].to_string()
            } else {
                format!("{}{}{}", &captures[1], REDACTED, &captures[3])
            }
        })
        .into_owned()
}

fn redact_assignment_line(line: &str) -> String {
    let newline = if line.ends_with('\n') { "\n" } else { "" };
    let content = line.strip_suffix('\n').unwrap_or(line);
    let leading_len = content.len() - content.trim_start().len();
    let (leading, rest) = content.split_at(leading_len);
    let Some(separator_index) = rest.find(['=', ':']) else {
        return line.to_string();
    };
    let (key, value_with_separator) = rest.split_at(separator_index);
    if key.is_empty()
        || !key.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
        || !looks_secret_name(key)
    {
        return line.to_string();
    }
    let separator = &value_with_separator[..1];
    let value = &value_with_separator[1..];
    if safe_placeholder(value.trim()) {
        return line.to_string();
    }
    format!("{leading}{key}{separator}{REDACTED}{newline}")
}

fn looks_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "PASSWORD",
        "TOKEN",
        "SECRET",
        "PRIVATE_KEY",
        "API_KEY",
        "ACCESS_KEY",
        "DATABASE_URL",
        "REDIS_URL",
        "CONNECTION_STRING",
        "DSN",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn safe_placeholder(value: &str) -> bool {
    let value = value.trim_matches(['\'', '"']);
    value.is_empty()
        || value.starts_with('$')
        || (value.starts_with('<') && value.ends_with('>'))
        || value.eq_ignore_ascii_case("replace-me")
}

#[must_use]
pub fn contains_probable_secret(input: &str) -> bool {
    let redacted = redact_text(input);
    redacted != input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_common_secret_shapes() {
        let input = concat!(
            "API_KEY=actual-value\n",
            "PASSWORD: another-value\n",
            "Authorization: Bearer abc.def.ghi\n",
            "https://user:password@example.com/path\n",
            "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
        );
        let output = redact_text(input);
        assert!(!output.contains("actual-value"));
        assert!(!output.contains("another-value"));
        assert!(!output.contains("abc.def.ghi"));
        assert!(!output.contains("password@example.com"));
        assert!(!output.contains("\nsecret\n"));
    }

    #[test]
    fn preserves_empty_values_and_variable_references() {
        let input = concat!(
            "API_KEY=\n",
            "TCR_PASSWORD=${TCR_PASSWORD}\n",
            "CNB_PUSH_TOKEN: ${{ secrets.CNB_PUSH_TOKEN }}\n",
            "https://oauth2:${CNB_PUSH_TOKEN}@cnb.cool/repo.git\n",
        );
        assert_eq!(redact_text(input), input);
    }
}
