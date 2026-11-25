Class {
	#name : #SRRedawLatentField,
	#superclass : #SRObject,
	#instVars : [
		'entries',
		'style',
		'stats',
		'material',
		'geometry'
	],
	#category : #'Redaw-XR'
}

{
	#category : #shaders,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:54'
}
SRRedawLatentField class >> redawLatent [
	<shaderSource: #redawLatent>
	"Latent frames as columns. Texture rows are frames: the vector, its length, its movement, the page RGB. Clip rows map world space onto a window's plate; zeros clip nothing."
	^ {
		#uniforms -> #(heightParams refs geometry style style2 order clip).
		#vert -> '#version 450

layout(location = 0) in vec3 vertexPosition;
layout(location = 1) in vec2 vertexTexCoord;
layout(location = 3) in vec4 vertexColor;

layout(location = 0) uniform mat4 mvp;
layout(location = 5) uniform mat4 matModel;
layout(location = 6) uniform vec4 heightParams;
layout(location = 7) uniform vec4 refs;
layout(location = 8) uniform vec4 geometry;
layout(binding = 0) uniform sampler2D texture0;

layout(location = 0) out vec2 fragTexCoord;
layout(location = 1) out vec4 fragColor;
layout(location = 2) out vec3 fragPosition;

float valueAt(int frame, int column)
{
    return texelFetch(texture0, ivec2(column, frame), 0).r;
}

float columnHeight(int frame)
{
    int mode = int(heightParams.x + 0.5);
    int dims = int(geometry.z + 0.5);
    int dim = int(heightParams.y + 0.5);
    float v = 0.0;
    if (mode == 1) v = valueAt(frame, dims) / refs.x;
    else if (mode == 2) v = valueAt(frame, dims + 1) / refs.y;
    else if (mode == 3) v = abs(valueAt(frame, dim)) / refs.w;
    else if (mode == 4) v = 0.5 + 0.5 * valueAt(frame, dim) / refs.w;
    return heightParams.w + heightParams.z * clamp(v, 0.0, 1.5);
}

void main()
{
    int frame = int(vertexTexCoord.x);
    float centre = (float(frame) + 0.5) * geometry.x;
    vec3 p = vertexPosition;
    p.x = centre + (p.x - centre) * (1.0 - geometry.y);
    p.z = p.z * columnHeight(frame);
    fragTexCoord = vertexTexCoord;
    fragColor = vertexColor;
    fragPosition = vec3(matModel * vec4(p, 1.0));
    gl_Position = mvp * vec4(p, 1.0);
}
'.
		#frag -> '#version 450

layout(location = 0) in vec2 fragTexCoord;
layout(location = 1) in vec4 fragColor;
layout(location = 2) in vec3 fragPosition;

layout(location = 7) uniform vec4 refs;
layout(location = 8) uniform vec4 geometry;
layout(location = 9) uniform vec4 style;
layout(location = 10) uniform vec4 style2;
layout(location = 11) uniform vec4 order[32];
layout(location = 43) uniform vec4 clip[3];
layout(binding = 0) uniform sampler2D texture0;

layout(location = 0) out vec4 finalColor;

float valueAt(int frame, int column)
{
    return texelFetch(texture0, ivec2(column, frame), 0).r;
}

vec3 diverge(float v)
{
    float a = pow(min(abs(v), 1.0), 0.6);
    vec3 tone = v > 0.0 ? vec3(1.0, 0.55, 0.12) : vec3(0.15, 0.45, 1.0);
    return mix(vec3(0.06), tone, a);
}

void main()
{
    vec4 cp = vec4(fragPosition, 1.0);
    vec3 cq = vec3(dot(clip[0], cp), dot(clip[1], cp), dot(clip[2], cp));
    if (any(greaterThan(abs(cq), vec3(0.5)))) discard;
    vec3 n = normalize(cross(dFdx(fragPosition), dFdy(fragPosition)));
    float light = 0.55 + 0.45 * abs(dot(n, normalize(vec3(0.3, 0.85, 0.4))));
    int frame = int(fragTexCoord.x);
    int dims = int(geometry.z + 0.5);
    int mode = int(style.x + 0.5);
    int place = int(style.y + 0.5);
    int count = int(style.w + 0.5);
    int selected = int(style2.z + 0.5);
    bool top = fragColor.a > 0.75;
    bool side = fragColor.a > 0.25 && !top;
    bool carries = (place == 0 && top) || (place == 1 && side) || (place == 2 && (top || side));
    vec3 page = vec3(valueAt(frame, dims + 2), valueAt(frame, dims + 3), valueAt(frame, dims + 4));
    vec3 c = page;
    if (mode == 3) {
        c = diverge(valueAt(frame, selected) / refs.z * style.z);
    } else if (mode > 0 && carries) {
        float cell = clamp(fragTexCoord.y, 0.0, 0.9999) * float(count);
        int k = int(cell);
        int dim = style2.x > 0.5 ? int(order[k / 4][k % 4] + 0.5) : k;
        float v = valueAt(frame, dim) / refs.z * style.z;
        c = mode == 1 ? diverge(v) : page * (0.2 + 1.6 * min(abs(v), 1.0));
        if (style2.y > 0.5 && fract(cell) < fwidth(cell)) c *= 0.4;
        if (style2.w > 0.5 && dim == selected) c = mix(c, vec3(1.0), 0.5);
    }
    finalColor = vec4(c * light, 1.0);
}
'
	} as: Dictionary
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentField >> add: aStrip at: aVector3 [
	entries add: aStrip -> (Matrix4x4 withOffset: aVector3).
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentField >> initialize [
	super initialize.
	entries := OrderedCollection new.
	geometry := ByteArray new: 16.
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:54'
}
SRRedawLatentField >> renderOn: aRenderer [
	"On the Quest there is no transpiler: the shader must arrive in the shader cache. In a window, strips off its plate are skipped and the shader cuts the ones across its edge."
	| shader rlMaterial base portal |
	(entries isEmpty or: [stats isNil]) ifTrue: [^ self].
	(SRShader hasCachedShader: #redawLatent) ifFalse: [^ self].
	shader := SRShader named: #redawLatent.
	material ifNil: [material := SRMaterial new shader: shader; yourself].
	rlMaterial := material internalMaterialFor: aRenderer.
	style applyTo: shader stats: stats.
	Raylib setShaderValueVShader: shader internalShader locIndex: (shader uniformLocAt: #clip) value: SRRedawCanvasPortal clip uniformType: 3 count: 3.
	portal := SRRedawCanvasPortal active.
	base := self globalTransform.
	aRenderer withoutBackfaceCullingDo: [
		entries do: [:each | | strip transform |
			strip := each key.
			transform := base composedWithLocal: each value.
			(portal isNil or: [portal
				showsCanvasRectFrom: (transform localPointToGlobal: 0 @ -5cm @ 0)
				to: (transform localPointToGlobal: strip length @ 5cm @ 0)]) ifTrue: [
					geometry
						floatAt: 1 put: strip frameWidth asFloat;
						floatAt: 5 put: style gap asFloat;
						floatAt: 9 put: strip dims asFloat.
					Raylib setShaderValueShader: shader internalShader locIndex: (shader uniformLocAt: #geometry) value: geometry uniformType: 3.
					material albedoMap texture: strip texture internalTexture.
					Raylib
						drawMesh: strip mesh internalMesh
						material: rlMaterial
						transform: transform asRlMatrix]]].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentField >> stats: aStats [
	stats := aStats.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentField >> style: aStyle [
	style := aStyle.
]
