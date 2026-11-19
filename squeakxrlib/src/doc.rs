//! JSON views of and edits to the Automerge document, addressed by slash-separated paths
//! (`state/timeline.layers/items/<id>/name`; `~1` escapes `/`, `~0` escapes `~`; list items by
//! index, `-` appends).
//!
//! Writes follow latent-canvas `live/net/shared.js` (`toDoc`): strings shorter than 256 UTF-16
//! units become collaborative text, longer ones plain strings; integers become `int`, other
//! numbers `f64`.

use anyhow::{anyhow, bail, Result};
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, Prop, ReadDoc, ScalarValue, Value, ROOT};
use serde_json::{Map, Number, Value as Json};

const LONG: usize = 256;

pub fn parse_path(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect()
}

/// The JSON value at `path` (empty = the whole document), or None if nothing is there.
pub fn get_json(doc: &AutoCommit, path: &str) -> Result<Option<Json>> {
    let mut obj = ROOT;
    let mut ty = ObjType::Map;
    for seg in parse_path(path) {
        let prop = match ty {
            ObjType::Map | ObjType::Table => Prop::Map(seg),
            ObjType::List => match seg.parse::<usize>() {
                Ok(i) => Prop::Seq(i),
                Err(_) => return Ok(None),
            },
            ObjType::Text => return Ok(None),
        };
        match doc.get(&obj, prop)? {
            None => return Ok(None),
            Some((Value::Object(t), id)) => {
                obj = id;
                ty = t;
            }
            Some((Value::Scalar(s), _)) => return Ok(Some(scalar_json(&s))),
        }
    }
    Ok(Some(obj_json(doc, &obj, ty)))
}

pub fn put_json(doc: &mut AutoCommit, path: &str, value: &Json) -> Result<()> {
    let (parent, ty, last) = parent_of(doc, path)?;
    match ty {
        ObjType::Map | ObjType::Table => put_value(doc, &parent, Prop::Map(last), value),
        ObjType::List => {
            let len = doc.length(&parent);
            let i = if last == "-" { len } else { last.parse::<usize>().map_err(|_| anyhow!("{last:?} is not a list index"))? };
            if i == len {
                insert_value(doc, &parent, i, value)
            } else if i < len {
                put_value(doc, &parent, Prop::Seq(i), value)
            } else {
                bail!("index {i} is past the end of the list (length {len})")
            }
        }
        ObjType::Text => bail!("cannot write inside a text object"),
    }
}

pub fn delete(doc: &mut AutoCommit, path: &str) -> Result<()> {
    let (parent, ty, last) = parent_of(doc, path)?;
    match ty {
        ObjType::Map | ObjType::Table => doc.delete(&parent, last)?,
        ObjType::List => {
            let i = last.parse::<usize>().map_err(|_| anyhow!("{last:?} is not a list index"))?;
            if i >= doc.length(&parent) {
                bail!("index {i} is past the end of the list");
            }
            doc.delete(&parent, i)?
        }
        ObjType::Text => bail!("cannot delete inside a text object"),
    }
    Ok(())
}

/// The container holding the last path segment, its type, and that segment.
fn parent_of(doc: &AutoCommit, path: &str) -> Result<(ObjId, ObjType, String)> {
    let mut segs = parse_path(path);
    let last = segs.pop().ok_or_else(|| anyhow!("path must name a key below the document root"))?;
    let mut obj = ROOT;
    let mut ty = ObjType::Map;
    for seg in segs {
        let prop = match ty {
            ObjType::Map | ObjType::Table => Prop::Map(seg.clone()),
            ObjType::List => Prop::Seq(seg.parse().map_err(|_| anyhow!("{seg:?} is not a list index"))?),
            ObjType::Text => bail!("{seg:?}: cannot descend into a text object"),
        };
        match doc.get(&obj, prop)? {
            Some((Value::Object(t), id)) => {
                obj = id;
                ty = t;
            }
            Some(_) => bail!("{seg:?} is not a map or list"),
            None => bail!("{seg:?} does not exist"),
        }
    }
    Ok((obj, ty, last))
}

fn obj_json(doc: &AutoCommit, obj: &ObjId, ty: ObjType) -> Json {
    match ty {
        ObjType::Map | ObjType::Table => {
            let mut m = Map::new();
            for key in doc.keys(obj) {
                if let Ok(Some((v, id))) = doc.get(obj, key.as_str()) {
                    m.insert(key, value_json(doc, v, &id));
                }
            }
            Json::Object(m)
        }
        ObjType::List => Json::Array(
            (0..doc.length(obj))
                .filter_map(|i| doc.get(obj, i).ok().flatten())
                .map(|(v, id)| value_json(doc, v, &id))
                .collect(),
        ),
        ObjType::Text => Json::String(doc.text(obj).unwrap_or_default()),
    }
}

fn value_json(doc: &AutoCommit, v: Value<'_>, id: &ObjId) -> Json {
    match v {
        Value::Object(t) => obj_json(doc, id, t),
        Value::Scalar(s) => scalar_json(&s),
    }
}

fn scalar_json(s: &ScalarValue) -> Json {
    match s {
        ScalarValue::Str(s) => Json::String(s.to_string()),
        ScalarValue::Int(i) | ScalarValue::Timestamp(i) => Json::from(*i),
        ScalarValue::Uint(u) => Json::from(*u),
        ScalarValue::F64(f) => Number::from_f64(*f).map(Json::Number).unwrap_or(Json::Null),
        ScalarValue::Counter(_) => s.as_i64().map(Json::from).unwrap_or(Json::Null),
        ScalarValue::Boolean(b) => Json::Bool(*b),
        ScalarValue::Bytes(b) => Json::Array(b.iter().map(|x| Json::from(*x)).collect()),
        ScalarValue::Null | ScalarValue::Unknown { .. } => Json::Null,
    }
}

fn scalar_of(v: &Json) -> Option<ScalarValue> {
    Some(match v {
        Json::Null => ScalarValue::Null,
        Json::Bool(b) => ScalarValue::Boolean(*b),
        Json::Number(n) => match n.as_i64() {
            Some(i) => ScalarValue::Int(i),
            None => ScalarValue::F64(n.as_f64().unwrap_or(f64::NAN)),
        },
        Json::String(s) if s.encode_utf16().count() >= LONG => ScalarValue::Str(s.as_str().into()),
        _ => return None,
    })
}

fn put_value(doc: &mut AutoCommit, obj: &ObjId, prop: Prop, v: &Json) -> Result<()> {
    if let Some(s) = scalar_of(v) {
        doc.put(obj, prop, s)?;
        return Ok(());
    }
    match v {
        Json::String(s) => {
            let t = doc.put_object(obj, prop, ObjType::Text)?;
            doc.splice_text(&t, 0, 0, s)?;
        }
        Json::Array(items) => {
            let l = doc.put_object(obj, prop, ObjType::List)?;
            fill_list(doc, &l, items)?;
        }
        Json::Object(m) => {
            let o = doc.put_object(obj, prop, ObjType::Map)?;
            fill_map(doc, &o, m)?;
        }
        _ => unreachable!("scalars are handled above"),
    }
    Ok(())
}

fn insert_value(doc: &mut AutoCommit, list: &ObjId, i: usize, v: &Json) -> Result<()> {
    if let Some(s) = scalar_of(v) {
        doc.insert(list, i, s)?;
        return Ok(());
    }
    match v {
        Json::String(s) => {
            let t = doc.insert_object(list, i, ObjType::Text)?;
            doc.splice_text(&t, 0, 0, s)?;
        }
        Json::Array(items) => {
            let l = doc.insert_object(list, i, ObjType::List)?;
            fill_list(doc, &l, items)?;
        }
        Json::Object(m) => {
            let o = doc.insert_object(list, i, ObjType::Map)?;
            fill_map(doc, &o, m)?;
        }
        _ => unreachable!("scalars are handled above"),
    }
    Ok(())
}

fn fill_list(doc: &mut AutoCommit, l: &ObjId, items: &[Json]) -> Result<()> {
    for (i, x) in items.iter().enumerate() {
        insert_value(doc, l, i, x)?;
    }
    Ok(())
}

fn fill_map(doc: &mut AutoCommit, o: &ObjId, m: &Map<String, Json>) -> Result<()> {
    for (k, x) in m {
        put_value(doc, o, Prop::Map(k.clone()), x)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn put_get_delete() {
        let mut doc = AutoCommit::new();
        put_json(&mut doc, "meta", &json!({ "name": "s", "created": 1 })).unwrap();
        put_json(&mut doc, "state", &json!({ "a/b": [1, 2.5, "x", "y".repeat(300), null, true] })).unwrap();
        put_json(&mut doc, "state/a~1b/-", &json!({ "k": "v" })).unwrap();
        assert_eq!(get_json(&doc, "meta/name").unwrap(), Some(json!("s")));
        assert_eq!(get_json(&doc, "state/a~1b/6/k").unwrap(), Some(json!("v")));
        assert_eq!(get_json(&doc, "state/a~1b/1").unwrap(), Some(json!(2.5)));
        delete(&mut doc, "state/a~1b/0").unwrap();
        assert_eq!(get_json(&doc, "state/a~1b/0").unwrap(), Some(json!(2.5)));
        assert_eq!(get_json(&doc, "nope/x").unwrap(), None);
        assert!(get_json(&doc, "").unwrap().unwrap()["meta"].is_object());
    }
}
