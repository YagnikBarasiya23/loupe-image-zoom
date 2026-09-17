import Loupe from './loupe.js';

const $ = selector => document.querySelector(selector);
const viewer = new Loupe($('#viewer'));

const radio = (group, button) => {
  document.querySelectorAll(group).forEach(b => b.setAttribute('aria-checked', String(b === button)));
};

document.querySelectorAll('.thumbs button').forEach(button => {
  button.addEventListener('click', () => {
    radio('.thumbs button', button);
    viewer.setImage(button.dataset.src, button.dataset.zoom, button.dataset.alt);
  });
});

document.querySelectorAll('[data-mode]').forEach(button => {
  button.addEventListener('click', () => {
    radio('[data-mode]', button);
    viewer.configure({ mode: button.dataset.mode });
    $('#size').disabled = button.dataset.mode === 'inside';
  });
});

$('#zoom').addEventListener('input', event => {
  $('#zoom-out').textContent = `${Number(event.target.value).toFixed(1)}×`;
  viewer.configure({ zoom: Number(event.target.value) });
});
$('#viewer').addEventListener('loupe:zoom', event => {
  $('#zoom').value = event.detail.zoom;
  $('#zoom-out').textContent = `${event.detail.zoom.toFixed(1)}×`;
});
$('#size').addEventListener('input', event => {
  $('#size-out').textContent = `${event.target.value} px`;
  viewer.configure({ size: Number(event.target.value) });
});
$('#wheel').addEventListener('change', event => viewer.configure({ wheel: event.target.checked }));
