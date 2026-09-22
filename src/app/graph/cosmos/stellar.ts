import * as THREE from "three";

export function createPhotosphere(radius: number, color: string): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
        uniforms: {
            surfaceColor: { value: new THREE.Color(color) },
            time: { value: 0 },
        },
        vertexShader: `
            varying vec3 surfacePosition;
            varying vec3 viewNormal;
            varying vec3 viewDirection;
            void main() {
                surfacePosition = normalize(position);
                vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
                viewNormal = normalize(normalMatrix * normal);
                viewDirection = normalize(-viewPosition.xyz);
                gl_Position = projectionMatrix * viewPosition;
            }
        `,
        fragmentShader: `
            uniform vec3 surfaceColor;
            uniform float time;
            varying vec3 surfacePosition;
            varying vec3 viewNormal;
            varying vec3 viewDirection;
            float hash(vec3 p) {
                p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
                p *= 17.0;
                return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
            }
            float noise(vec3 p) {
                vec3 i = floor(p), f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                    mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                    mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
            }
            void main() {
                vec3 p = surfacePosition * 18.0 + vec3(0.0, time * 0.015, 0.0);
                float granules = noise(p) * 0.65 + noise(p * 2.8) * 0.35;
                float activity = noise(surfacePosition * 4.0 + time * 0.004);
                float limb = pow(max(0.0, dot(normalize(viewNormal), normalize(viewDirection))), 0.38);
                vec3 hot = mix(surfaceColor, vec3(1.0, 0.96, 0.88), 0.68);
                vec3 cool = mix(surfaceColor, hot, 0.34);
                vec3 color = mix(cool, hot, granules) * (0.8 + limb * 0.65);
                color *= 0.88 + smoothstep(0.24, 0.68, activity) * 0.24;
                gl_FragColor = vec4(color, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 56, 36), material);
}
