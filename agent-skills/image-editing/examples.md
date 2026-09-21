# Example Magica image calls

Generate:

```json
{ "prompt": "editorial photo of brass dice on dark wood" }
```

Edit:

```json
{ "prompt": "make the lighting colder", "image_url": "https://example.com/input.png" }
```

Crop (percent rectangle):

```json
{
  "image_url": "https://example.com/input.png",
  "x_percent": 10,
  "y_percent": 10,
  "width_percent": 80,
  "height_percent": 80
}
```
