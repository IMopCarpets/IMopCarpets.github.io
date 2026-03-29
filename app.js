let bookmarks = JSON.parse(localStorage.getItem("bookmarks")) || [];

function save() {
  localStorage.setItem("bookmarks", JSON.stringify(bookmarks));
}

function render() {
  const container = document.getElementById("bookmarks");
  container.innerHTML = "";

  bookmarks.forEach((b, i) => {
    const div = document.createElement("div");
    div.className = "card";

    div.innerHTML = `
      <h3>${b.name}</h3>
      <a href="${b.url}" target="_blank">ENTER</a>
      <div class="delete" onclick="removeBookmark(${i})">PURGE</div>
    `;

    container.appendChild(div);
  });
}

function addBookmark() {
  const name = document.getElementById("name").value;
  const url = document.getElementById("url").value;

  if (!name || !url) return;

  bookmarks.push({ name, url });
  save();
  render();

  document.getElementById("name").value = "";
  document.getElementById("url").value = "";
}

function removeBookmark(index) {
  bookmarks.splice(index, 1);
  save();
  render();
}

render();
